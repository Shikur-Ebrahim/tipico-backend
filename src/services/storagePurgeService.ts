import pool from '../config/database';
import { getFixtureWindowRange } from './apiFootball';

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'] as const;

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

/**
 * Remove all odds + live rows for finished matches (keeps fixture row for settled bets).
 * Default: 2 hours after kickoff time when status is FT/AET/PEN.
 * Set PURGE_FINISHED_ODDS_HOURS=0 to run on next purge tick right after FT.
 */
export async function purgeFinishedOddsAndLiveData(): Promise<PurgeCounts> {
  const hours = purgeHoursFromEnv('PURGE_FINISHED_ODDS_HOURS', 2);
  const counts: PurgeCounts = {
    odds_history: 0,
    live_odds: 0,
    odds: 0,
    live_events: 0,
    live_statistics: 0,
    live_matches: 0,
  };

  const finishedFixtureIds = `
    SELECT f.id
    FROM fixtures f
    WHERE f.status = ANY($1::text[])
      AND f.match_date < NOW() - make_interval(hours => $2::int)
  `;

  const rHist = await pool.query(
    `DELETE FROM odds_history
     WHERE odds_id IN (
       SELECT o.id FROM odds o
       WHERE o.fixture_id IN (${finishedFixtureIds})
     )`,
    [FINISHED_STATUSES, hours]
  );
  counts.odds_history = rHist.rowCount ?? 0;

  const rLiveOdds = await pool.query(
    `DELETE FROM live_odds WHERE fixture_id IN (${finishedFixtureIds})`,
    [FINISHED_STATUSES, hours]
  );
  counts.live_odds = rLiveOdds.rowCount ?? 0;

  const rOdds = await pool.query(
    `DELETE FROM odds WHERE fixture_id IN (${finishedFixtureIds})`,
    [FINISHED_STATUSES, hours]
  );
  counts.odds = rOdds.rowCount ?? 0;

  const rEvents = await pool.query(
    `DELETE FROM live_events WHERE fixture_id IN (${finishedFixtureIds})`,
    [FINISHED_STATUSES, hours]
  );
  counts.live_events = rEvents.rowCount ?? 0;

  const rStats = await pool.query(
    `DELETE FROM live_statistics WHERE fixture_id IN (${finishedFixtureIds})`,
    [FINISHED_STATUSES, hours]
  );
  counts.live_statistics = rStats.rowCount ?? 0;

  const rLiveMatches = await pool.query(
    `DELETE FROM live_matches WHERE fixture_id IN (${finishedFixtureIds})`,
    [FINISHED_STATUSES, hours]
  );
  counts.live_matches = rLiveMatches.rowCount ?? 0;

  const total =
    counts.odds_history +
    counts.odds +
    counts.live_odds +
    counts.live_events +
    counts.live_statistics +
    counts.live_matches;

  if (total > 0) {
    console.log(
      `[PURGE] Finished-match odds/live cleanup (${hours}h after kickoff):`,
      JSON.stringify(counts)
    );
  }

  return counts;
}

export type FixturePurgeCounts = PurgeCounts & { fixtures: number };

/**
 * Delete entire fixtures outside the rolling date window, or finished long enough ago,
 * when they are not referenced by any bet slip selection.
 *
 * Default finished retention: 6 hours (was 24). Override with PURGE_FINISHED_FIXTURE_HOURS.
 */
export async function purgeStoredFixturesOutsideWindow(): Promise<FixturePurgeCounts> {
  const { start, endExclusive } = getFixtureWindowRange();
  const finishedHours = purgeHoursFromEnv('PURGE_FINISHED_FIXTURE_HOURS', 6);

  const targetFixturesQuery = `
    SELECT f.id
    FROM fixtures f
    WHERE (
      f.match_date < $1 OR f.match_date >= $2
      OR (
        f.status = ANY($3::text[])
        AND f.match_date < NOW() - make_interval(hours => $4::int)
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM bet_selections bs WHERE bs.fixture_id = f.id
    )
  `;

  const queryParams = [start, endExclusive, FINISHED_STATUSES, finishedHours];

  const counts: FixturePurgeCounts = {
    odds_history: 0,
    live_odds: 0,
    odds: 0,
    live_events: 0,
    live_statistics: 0,
    live_matches: 0,
    fixtures: 0,
  };

  counts.odds_history =
    (
      await pool.query(
        `DELETE FROM odds_history
         WHERE odds_id IN (
           SELECT o.id FROM odds o WHERE o.fixture_id IN (${targetFixturesQuery})
         )`,
        queryParams
      )
    ).rowCount ?? 0;

  counts.live_odds =
    (
      await pool.query(
        `DELETE FROM live_odds WHERE fixture_id IN (${targetFixturesQuery})`,
        queryParams
      )
    ).rowCount ?? 0;

  counts.odds =
    (
      await pool.query(`DELETE FROM odds WHERE fixture_id IN (${targetFixturesQuery})`, queryParams)
    ).rowCount ?? 0;

  counts.live_events =
    (
      await pool.query(
        `DELETE FROM live_events WHERE fixture_id IN (${targetFixturesQuery})`,
        queryParams
      )
    ).rowCount ?? 0;

  counts.live_statistics =
    (
      await pool.query(
        `DELETE FROM live_statistics WHERE fixture_id IN (${targetFixturesQuery})`,
        queryParams
      )
    ).rowCount ?? 0;

  counts.live_matches =
    (
      await pool.query(
        `DELETE FROM live_matches WHERE fixture_id IN (${targetFixturesQuery})`,
        queryParams
      )
    ).rowCount ?? 0;

  counts.fixtures =
    (
      await pool.query(`DELETE FROM fixtures WHERE id IN (${targetFixturesQuery})`, queryParams)
    ).rowCount ?? 0;

  const total =
    counts.odds_history +
    counts.odds +
    counts.live_odds +
    counts.live_events +
    counts.live_statistics +
    counts.live_matches +
    counts.fixtures;

  if (total > 0) {
    console.log(
      `[PURGE] Fixture window / finished cleanup (fixture retention ${finishedHours}h):`,
      JSON.stringify(counts)
    );
  }

  return counts;
}

/** Odds/live cleanup then full fixture purge (safe for cron). */
export async function runStoragePurge() {
  const odds = await purgeFinishedOddsAndLiveData();
  const fixtures = await purgeStoredFixturesOutsideWindow();
  return { odds, fixtures };
}
