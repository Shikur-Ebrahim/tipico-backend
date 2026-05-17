import { Router, Request, Response } from 'express';
import pool from '../config/database';

import { getFixtureWindowRange } from '../services/apiFootball';
import { runBootstrapSync, runOddsSync } from '../services/syncService';
import { sqlFixtureHasDisplayableOdds } from '../utils/displayableOdds';
import { buildRollingDayIds, getDayRangeFromId } from '../utils/fixtureDayFilter';

const router = Router();

const MAX_FIXTURES_PAGE = 5000;

/** Cooldown between background bootstraps triggered by empty fixture list (ms). */
const BOOTSTRAP_ON_EMPTY_COOLDOWN_MS = 90 * 60 * 1000;

let lastBootstrapOnEmptyAt = 0;
let lastOddsBackfillAt = 0;
const ODDS_BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;

function maybeTriggerOddsBackfill(): void {
  const v = process.env.AUTO_ODDS_BACKFILL_ON_LIST;
  if (v === '0' || v === 'false' || v === 'no') return;
  const now = Date.now();
  if (now - lastOddsBackfillAt < ODDS_BACKFILL_COOLDOWN_MS) return;
  lastOddsBackfillAt = now;
  void runOddsSync(200).catch((err) =>
    console.error('[fixtures] background odds backfill failed:', err)
  );
}

/** Default ON: kick a background API sync when /fixtures returns no rows in the rolling window. Set BOOTSTRAP_ON_EMPTY_FIXTURES=0 to disable. */
function autoBootstrapOnEmptyListEnabled(): boolean {
  const v = process.env.BOOTSTRAP_ON_EMPTY_FIXTURES;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

function maybeTriggerBootstrapOnEmpty(params: {
  rowCount: number;
  pageNum: number;
  hasDate: boolean;
  hasLeague: boolean;
  hasStatus: boolean;
  listAllMode: boolean;
}): void {
  if (!autoBootstrapOnEmptyListEnabled()) return;
  if (params.listAllMode) return;
  if (params.hasDate || params.hasLeague || params.hasStatus) return;
  if (params.pageNum !== 1) return;
  if (params.rowCount > 0) return;

  const now = Date.now();
  if (now - lastBootstrapOnEmptyAt < BOOTSTRAP_ON_EMPTY_COOLDOWN_MS) return;
  lastBootstrapOnEmptyAt = now;

  void runBootstrapSync()
    .then(() => runOddsSync(200))
    .catch((err) => console.error('[fixtures] BOOTSTRAP_ON_EMPTY background sync failed:', err));
}

/** List up to MAX rows without rolling date window (after bulk migrate / large DB). Set on Render if needed. */
function listAllFixturesInDb(): boolean {
  const v = process.env.FIXTURE_LIST_ALL_IN_DB;
  return v === '1' || v === 'true' || v === 'yes';
}

function emptyFixtureMeta() {
  return {
    total: 0,
    days: buildRollingDayIds().map((id) => ({ id, count: 0 })),
    countries: [{ name: 'All countries', count: 0, flag_url: null as string | null }],
  };
}

router.get('/meta', async (req: Request, res: Response) => {
  try {
    const onlyWithOdds =
      req.query.has_odds === '1' ||
      req.query.has_odds === 'true' ||
      req.query.has_odds === 'yes';
    const countryDay = typeof req.query.day === 'string' ? req.query.day : 'all';
    const { start: windowStart, endExclusive: windowEnd } = getFixtureWindowRange();

    const oddsSql = onlyWithOdds ? `AND ${sqlFixtureHasDisplayableOdds('f')}` : '';
    const baseFrom = `
      FROM fixtures f
      JOIN leagues l ON f.league_id = l.id
      LEFT JOIN countries c ON l.country_id = c.id
      WHERE f.match_date >= $1 AND f.match_date < $2
        AND (f.status <> 'FT' OR f.match_date > NOW() - INTERVAL '2 hours')
        ${oddsSql}`;

    const dayIds = buildRollingDayIds().filter((id) => id !== 'all');
    const dayFilters: string[] = [];
    const dayParams: (string | number | Date)[] = [windowStart, windowEnd];
    let p = 3;
    for (const dayId of dayIds) {
      const range = getDayRangeFromId(dayId);
      if (!range) continue;
      const key = dayId.replace(/[^a-z0-9_]/gi, '_');
      dayFilters.push(
        `COUNT(*) FILTER (WHERE f.match_date >= $${p} AND f.match_date < $${p + 1})::int AS d_${key}`
      );
      dayParams.push(range.start, range.endExclusive);
      p += 2;
    }

    const { rows: aggRows } = await pool.query<Record<string, number>>(
      `SELECT COUNT(*)::int AS total${dayFilters.length ? `, ${dayFilters.join(', ')}` : ''} ${baseFrom}`,
      dayParams
    );
    const agg = aggRows[0] || { total: 0 };
    const total = Number(agg.total) || 0;

    const days: { id: string; count: number }[] = [{ id: 'all', count: total }];
    for (const dayId of dayIds) {
      const key = `d_${dayId.replace(/[^a-z0-9_]/gi, '_')}`;
      days.push({ id: dayId, count: Number(agg[key]) || 0 });
    }

    let countrySql = `SELECT COALESCE(c.name, 'International') AS name,
        MAX(c.flag_url) AS flag_url,
        COUNT(*)::int AS count
      ${baseFrom}`;
    const countryParams: (string | number | Date)[] = [windowStart, windowEnd];
    const dayRange = getDayRangeFromId(countryDay);
    if (dayRange) {
      countrySql += ` AND f.match_date >= $3 AND f.match_date < $4`;
      countryParams.push(dayRange.start, dayRange.endExclusive);
    }
    countrySql += ` GROUP BY COALESCE(c.name, 'International') ORDER BY name ASC`;

    const { rows: countryRows } = await pool.query<{
      name: string;
      flag_url: string | null;
      count: number;
    }>(countrySql, countryParams);

    const countryTotal = countryRows.reduce((sum, row) => sum + row.count, 0);

    res.json({
      total,
      days,
      countries: [
        { name: 'All countries', count: countryTotal, flag_url: null },
        ...countryRows.map((r) => ({
          name: r.name,
          count: r.count,
          flag_url: r.flag_url,
        })),
      ],
    });
  } catch (err) {
    console.error('[fixtures/meta]', err);
    res.status(200).json(emptyFixtureMeta());
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      league_id,
      api_league_id,
      country,
      day,
      status,
      date,
      page = '1',
      limit = '20',
      has_odds,
    } = req.query;
    const onlyWithOdds =
      has_odds === '1' || has_odds === 'true' || has_odds === 'yes';
    const rawLimit = parseInt(limit as string, 10);
    const pageLimit = Number.isFinite(rawLimit)
      ? Math.min(MAX_FIXTURES_PAGE, Math.max(1, rawLimit))
      : 20;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const offset = (pageNum - 1) * pageLimit;
    const hasExplicitDate = Boolean(date);

    let query = `
      SELECT f.*,
        ht.name as home_team_name, ht.logo as home_team_logo,
        at.name as away_team_name, at.logo as away_team_logo,
        l.name as league_name, l.logo as league_logo, l.api_league_id,
        c.name as country_name, c.flag_url,
        v.name as venue_name, v.city as venue_city
      FROM fixtures f
      JOIN teams ht ON f.home_team_id = ht.id
      JOIN teams at ON f.away_team_id = at.id
      JOIN leagues l ON f.league_id = l.id
      LEFT JOIN countries c ON l.country_id = c.id
      LEFT JOIN venues v ON f.venue_id = v.id
      WHERE 1=1
    `;
    const params: (string | number | Date)[] = [];
    let paramIndex = 1;

    if (league_id) {
      query += ` AND f.league_id = $${paramIndex++}`;
      params.push(parseInt(league_id as string, 10));
    }
    if (api_league_id) {
      query += ` AND l.api_league_id = $${paramIndex++}`;
      params.push(parseInt(api_league_id as string, 10));
    }
    if (country && country !== 'All countries') {
      if (country === 'International') {
        query += ` AND c.name IS NULL`;
      } else {
        query += ` AND c.name = $${paramIndex++}`;
        params.push(country as string);
      }
    }
    if (typeof day === 'string' && day !== 'all') {
      const range = getDayRangeFromId(day);
      if (range) {
        query += ` AND f.match_date >= $${paramIndex++} AND f.match_date < $${paramIndex++}`;
        params.push(range.start, range.endExclusive);
      }
    }
    if (status) {
      query += ` AND f.status = $${paramIndex++}`;
      params.push(status as string);
    }
    if (onlyWithOdds) {
      query += ` AND ${sqlFixtureHasDisplayableOdds('f')}`;
    }
    if (date) {
      query += ` AND DATE(f.match_date) = $${paramIndex++}`;
      params.push(date as string);
    } else if (!hasExplicitDate && !listAllFixturesInDb()) {
      const { start, endExclusive } = getFixtureWindowRange();
      query += ` AND f.match_date >= $${paramIndex++} AND f.match_date < $${paramIndex++}`;
      params.push(start, endExclusive);

      if (!status) {
        query += ` AND (f.status <> 'FT' OR f.match_date > NOW() - INTERVAL '2 hours')`;
      }
    } else if (!hasExplicitDate && listAllFixturesInDb() && !status) {
      query += ` AND (f.status <> 'FT' OR f.match_date > NOW() - INTERVAL '48 hours')`;
    }

    query += ` ORDER BY 
      (EXISTS (SELECT 1 FROM odds o WHERE o.fixture_id = f.id)) DESC,
      l.is_top DESC,
      l.top_rank ASC NULLS LAST,
      (CASE 
        WHEN f.status IN ('1H', '2H', 'HT', 'ET', 'P', 'LIVE') THEN 0 
        WHEN f.status = 'NS' THEN 1 
        ELSE 2 
      END) ASC,
      f.match_date ASC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(pageLimit, offset);

    const { rows } = await pool.query(query, params);
    if (onlyWithOdds && rows.length > 0) {
      maybeTriggerOddsBackfill();
    }
    maybeTriggerBootstrapOnEmpty({
      rowCount: rows.length,
      pageNum,
      hasDate: hasExplicitDate,
      hasLeague: Boolean(league_id),
      hasStatus: Boolean(status),
      listAllMode: listAllFixturesInDb(),
    });
    res.json(rows);
  } catch (err) {
    console.error('[fixtures] list failed:', err);
    res.status(200).json([]);
  }
});

router.get('/live', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*,
        ht.name as home_team_name, ht.logo as home_team_logo,
        at.name as away_team_name, at.logo as away_team_logo,
        l.name as league_name, l.logo as league_logo,
        c.name as country_name, c.flag_url,
        lm.minute as live_minute, lm.status as live_status
       FROM live_matches lm
       JOIN fixtures f ON lm.fixture_id = f.id
       JOIN teams ht ON f.home_team_id = ht.id
       JOIN teams at ON f.away_team_id = at.id
       JOIN leagues l ON f.league_id = l.id
       LEFT JOIN countries c ON l.country_id = c.id
       WHERE lm.is_active = true
       ORDER BY f.match_date ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch live matches' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const fixtureId = parseInt(req.params.id as string, 10);
    if (Number.isNaN(fixtureId)) {
      res.status(400).json({ error: 'Invalid fixture id' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT f.*,
        ht.name as home_team_name, ht.logo as home_team_logo,
        at.name as away_team_name, at.logo as away_team_logo,
        l.name as league_name, l.logo as league_logo,
        c.name as country_name, c.flag_url,
        v.name as venue_name, v.city as venue_city, v.capacity as venue_capacity
       FROM fixtures f
       JOIN teams ht ON f.home_team_id = ht.id
       JOIN teams at ON f.away_team_id = at.id
       JOIN leagues l ON f.league_id = l.id
       LEFT JOIN countries c ON l.country_id = c.id
       LEFT JOIN venues v ON f.venue_id = v.id
       WHERE f.id = $1`,
      [fixtureId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Fixture not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fixture' });
  }
});

export default router;
