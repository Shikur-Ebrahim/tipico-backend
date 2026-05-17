import pool from '../config/database';
import { getFixtureWindowRange } from './apiFootball';
import { buildRollingDayIds, getDayRangeFromId } from '../utils/fixtureDayFilter';
import { sqlFixtureHasDisplayableOdds } from '../utils/displayableOdds';

const MAX_FIXTURES_PAGE = 5000;

export type HomeFeedPayload = {
  fixtures: unknown[];
  odds: Record<string, unknown[]>;
};

export type HomeBootstrapPayload = HomeFeedPayload & {
  meta: {
    total: number;
    days: { id: string; count: number }[];
    countries: { name: string; count: number; flag_url: string | null }[];
  };
  topLeagues: unknown[];
};

export async function queryFixtureDayCounts(onlyWithOdds: boolean) {
  const { start: windowStart, endExclusive: windowEnd } = getFixtureWindowRange();
  const oddsSql = onlyWithOdds ? `AND ${sqlFixtureHasDisplayableOdds('f')}` : '';
  const baseFrom = `
      FROM fixtures f
      JOIN leagues l ON f.league_id = l.id
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
  return { total, days };
}

export async function queryFixtureCountryCounts(onlyWithOdds: boolean) {
  const { start: windowStart, endExclusive: windowEnd } = getFixtureWindowRange();
  const oddsSql = onlyWithOdds ? `AND ${sqlFixtureHasDisplayableOdds('f')}` : '';
  const { rows } = await pool.query<{
    name: string;
    flag_url: string | null;
    count: number;
  }>(
    `SELECT COALESCE(c.name, 'International') AS name,
        MAX(c.flag_url) AS flag_url,
        COUNT(*)::int AS count
      FROM fixtures f
      JOIN leagues l ON f.league_id = l.id
      LEFT JOIN countries c ON l.country_id = c.id
      WHERE f.match_date >= $1 AND f.match_date < $2
        AND (f.status <> 'FT' OR f.match_date > NOW() - INTERVAL '2 hours')
        ${oddsSql}
      GROUP BY COALESCE(c.name, 'International')
      ORDER BY count DESC, name ASC`,
    [windowStart, windowEnd]
  );
  return rows;
}

/** Fixtures + 1X2 odds for the home list (shared by /home and /bootstrap). */
export async function queryHomeFeed(opts: {
  pageLimit: number;
  day?: string;
  country?: string;
  api_league_id?: number;
}): Promise<HomeFeedPayload> {
  const pageLimit = Math.min(MAX_FIXTURES_PAGE, Math.max(1, opts.pageLimit));

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
      WHERE ${sqlFixtureHasDisplayableOdds('f')}
    `;
  const params: (string | number | Date)[] = [];
  let paramIndex = 1;

  if (opts.api_league_id) {
    query += ` AND l.api_league_id = $${paramIndex++}`;
    params.push(opts.api_league_id);
  }
  if (opts.country && opts.country !== 'All countries') {
    if (opts.country === 'International') {
      query += ` AND c.name IS NULL`;
    } else {
      query += ` AND c.name = $${paramIndex++}`;
      params.push(opts.country);
    }
  }
  if (opts.day && opts.day !== 'all') {
    const range = getDayRangeFromId(opts.day);
    if (range) {
      query += ` AND f.match_date >= $${paramIndex++} AND f.match_date < $${paramIndex++}`;
      params.push(range.start, range.endExclusive);
    }
  }

  const { start, endExclusive } = getFixtureWindowRange();
  query += ` AND f.match_date >= $${paramIndex++} AND f.match_date < $${paramIndex++}`;
  params.push(start, endExclusive);
  query += ` AND (f.status <> 'FT' OR f.match_date > NOW() - INTERVAL '2 hours')`;

  query += ` ORDER BY 
      l.is_top DESC,
      l.top_rank ASC NULLS LAST,
      (CASE 
        WHEN f.status IN ('1H', '2H', 'HT', 'ET', 'P', 'LIVE') THEN 0 
        WHEN f.status = 'NS' THEN 1 
        ELSE 2 
      END) ASC,
      f.match_date ASC LIMIT $${paramIndex++}`;
  params.push(pageLimit);

  const { rows: fixtures } = await pool.query(query, params);
  const ids = fixtures.map((f: { id: number }) => f.id);
  const odds: Record<string, unknown[]> = {};

  if (ids.length > 0) {
    const { rows: oddsRows } = await pool.query(
      `SELECT DISTINCT ON (o.fixture_id, o.selection)
          o.id, o.fixture_id, o.bookmaker_id, o.market_id, o.selection, o.odd_value, o.last_update,
          b.name as bookmaker_name, b.logo as bookmaker_logo,
          bm.name as market_name, bm.market_key
         FROM odds o
         JOIN bookmakers b ON o.bookmaker_id = b.id
         JOIN bet_markets bm ON o.market_id = bm.id
         WHERE o.fixture_id = ANY($1::int[])
           AND o.odd_value IS NOT NULL
           AND o.odd_value > 0
           AND (bm.market_key = '1' OR LOWER(bm.market_key) = '1x2')
           AND o.selection IN ('Home', 'Draw', 'Away', '1', 'X', '2')
         ORDER BY o.fixture_id, o.selection, o.last_update DESC NULLS LAST,
           CASE WHEN b.api_bookmaker_id = 8 THEN 0 ELSE 1 END`,
      [ids]
    );
    for (const row of oddsRows) {
      const fid = String((row as { fixture_id: number }).fixture_id);
      if (!odds[fid]) odds[fid] = [];
      odds[fid].push(row);
    }
  }

  return { fixtures, odds };
}

async function queryTopLeagues() {
  const { rows } = await pool.query(
    `SELECT l.*, c.name as country_name, c.flag_url
       FROM leagues l
       LEFT JOIN countries c ON l.country_id = c.id
       WHERE l.is_top = true
       ORDER BY l.top_rank ASC
       LIMIT 15`
  );
  return rows;
}

/** One DB round-trip batch for landing: matches, 7-day counts, countries, top leagues. */
export async function buildHomeBootstrapPayload(limit: number): Promise<HomeBootstrapPayload> {
  const onlyWithOdds = true;
  const [home, { total, days }, countryRows, topLeagues] = await Promise.all([
    queryHomeFeed({ pageLimit: limit }),
    queryFixtureDayCounts(onlyWithOdds),
    queryFixtureCountryCounts(onlyWithOdds),
    queryTopLeagues(),
  ]);

  return {
    fixtures: home.fixtures,
    odds: home.odds,
    meta: {
      total,
      days,
      countries: [
        { name: 'All countries', count: total, flag_url: null },
        ...countryRows.map((r) => ({
          name: r.name,
          count: r.count,
          flag_url: r.flag_url,
        })),
      ],
    },
    topLeagues,
  };
}
