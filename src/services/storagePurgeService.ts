import pool from '../config/database';
import { getFixtureWindowRange } from './apiFootball';

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'] as const;
const FIXTURE_BATCH_SIZE = Math.min(
  100,
  Math.max(5, parseInt(process.env.PURGE_BATCH_SIZE || '30', 10) || 30)
);

function purgeHoursFromEnv(envKey: string, defaultHours: number): number {
  const parsed = parseInt(process.env[envKey] || String(defaultHours), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultHours;
  return Math.min(parsed, 168);
}

export type PurgeCounts = {
  odds_history: number;
  live_odds: number;
  odds: number;
  live_events: number;
  live_statistics: number;
  live_matches: number;
};

function emptyCounts(): PurgeCounts {
  return {
    odds_history: 0,
    live_odds: 0,
    odds: 0,
    live_events: 0,
    live_statistics: 0,
    live_matches: 0,
  };
}

function addCounts(target: PurgeCounts, delta: PurgeCounts) {
  target.odds_history += delta.odds_history;
  target.live_odds += delta.live_odds;
  target.odds += delta.odds;
  target.live_events += delta.live_events;
  target.live_statistics += delta.live_statistics;
  target.live_matches += delta.live_matches;
}

/** Delete odds + live rows for a batch of fixture ids (keeps fixture rows). */
async function purgeOddsAndLiveForFixtureIds(fixtureIds: number[]): Promise<PurgeCounts> {
  const counts = emptyCounts();
  if (fixtureIds.length === 0) return counts;

  const { rows: oddsRows } = await pool.query<{ id: number }>(
    `SELECT id FROM odds WHERE fixture_id = ANY($1::int[])`,
    [fixtureIds]
  );
  const oddsIds = oddsRows.map((r) => r.id);

  const HISTORY_CHUNK = 10_000;
  for (let i = 0; i < oddsIds.length; i += HISTORY_CHUNK) {
    const chunk = oddsIds.slice(i, i + HISTORY_CHUNK);
    const r = await pool.query(`DELETE FROM odds_history WHERE odds_id = ANY($1::int[])`, [chunk]);
    counts.odds_history += r.rowCount ?? 0;
  }

  counts.live_odds =
    (await pool.query(`DELETE FROM live_odds WHERE fixture_id = ANY($1::int[])`, [fixtureIds]))
      .rowCount ?? 0;

  counts.odds =
    (await pool.query(`DELETE FROM odds WHERE fixture_id = ANY($1::int[])`, [fixtureIds])).rowCount ??
    0;

  counts.live_events =
    (await pool.query(`DELETE FROM live_events WHERE fixture_id = ANY($1::int[])`, [fixtureIds]))
      .rowCount ?? 0;

  counts.live_statistics =
    (
      await pool.query(`DELETE FROM live_statistics WHERE fixture_id = ANY($1::int[])`, [
        fixtureIds,
      ])
    ).rowCount ?? 0;

  counts.live_matches =
    (await pool.query(`DELETE FROM live_matches WHERE fixture_id = ANY($1::int[])`, [fixtureIds]))
      .rowCount ?? 0;

  return counts;
}

/** Walk fixtures by primary key cursor (avoids repeating the same LIMIT scan). */
async function purgeWithCursor(
  baseWhereSql: string,
  params: unknown[],
  label: string,
  onBatch: (ids: number[]) => Promise<PurgeCounts>
): Promise<PurgeCounts> {
  const totals = emptyCounts();
  let cursor = 0;
  let batch = 0;

  while (true) {
    const cursorParam = params.length + 1;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT f.id FROM fixtures f
       WHERE f.id > $${cursorParam} AND (${baseWhereSql})
       ORDER BY f.id
       LIMIT ${FIXTURE_BATCH_SIZE}`,
      [...params, cursor]
    );
    if (rows.length === 0) break;

    cursor = rows[rows.length - 1].id;
    batch += 1;
    const ids = rows.map((r) => r.id);
    const part = await onBatch(ids);
    addCounts(totals, part);
    console.log(
      `[PURGE] ${label} batch ${batch} (id≤${cursor}): ${ids.length} fixtures, −${part.odds} odds, −${part.odds_history} history`
    );
  }

  return totals;
}

/**
 * Remove odds + live data for finished matches (fixture rows kept for bets).
 */
export async function purgeFinishedOddsAndLiveData(): Promise<PurgeCounts> {
  const hours = purgeHoursFromEnv('PURGE_FINISHED_ODDS_HOURS', 2);

  const totals = await purgeWithCursor(
    `f.status = ANY($1::text[]) AND f.match_date < NOW() - make_interval(hours => $2::int)`,
    [FINISHED_STATUSES, hours],
    `finished odds (${hours}h)`,
    purgeOddsAndLiveForFixtureIds
  );

  const total =
    totals.odds_history +
    totals.odds +
    totals.live_odds +
    totals.live_events +
    totals.live_statistics +
    totals.live_matches;

  if (total > 0) {
    console.log(`[PURGE] Finished odds/live done:`, JSON.stringify(totals));
  }

  return totals;
}

export type FixturePurgeCounts = PurgeCounts & { fixtures: number };

/**
 * Delete fixtures outside rolling window or finished (no bet selections).
 */
export async function purgeStoredFixturesOutsideWindow(): Promise<FixturePurgeCounts> {
  const { start, endExclusive } = getFixtureWindowRange();
  const finishedHours = purgeHoursFromEnv('PURGE_FINISHED_FIXTURE_HOURS', 6);

  const whereSql = `(
      f.match_date < $1 OR f.match_date >= $2
      OR (
        f.status = ANY($3::text[])
        AND f.match_date < NOW() - make_interval(hours => $4::int)
      )
    )
    AND NOT EXISTS (SELECT 1 FROM bet_selections bs WHERE bs.fixture_id = f.id LIMIT 1)`;

  const params = [start, endExclusive, FINISHED_STATUSES, finishedHours];
  const totals: FixturePurgeCounts = { ...emptyCounts(), fixtures: 0 };
  let cursor = 0;
  let batch = 0;

  while (true) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT f.id FROM fixtures f
       WHERE f.id > $5 AND ${whereSql}
       ORDER BY f.id
       LIMIT ${FIXTURE_BATCH_SIZE}`,
      [...params, cursor]
    );
    if (rows.length === 0) break;

    cursor = rows[rows.length - 1].id;
    batch += 1;
    const ids = rows.map((r) => r.id);
    const part = await purgeOddsAndLiveForFixtureIds(ids);
    addCounts(totals, part);
    totals.fixtures +=
      (await pool.query(`DELETE FROM fixtures WHERE id = ANY($1::int[])`, [ids])).rowCount ?? 0;

    console.log(
      `[PURGE] fixture window batch ${batch} (id≤${cursor}): ${ids.length} fixtures removed, −${part.odds} odds`
    );
  }

  const total =
    totals.odds_history +
    totals.odds +
    totals.live_odds +
    totals.live_events +
    totals.live_statistics +
    totals.live_matches +
    totals.fixtures;

  if (total > 0) {
    console.log(`[PURGE] Fixture window done:`, JSON.stringify(totals));
  }

  return totals;
}

export async function runStoragePurge() {
  const odds = await purgeFinishedOddsAndLiveData();
  const fixtures = await purgeStoredFixturesOutsideWindow();
  return { odds, fixtures };
}
