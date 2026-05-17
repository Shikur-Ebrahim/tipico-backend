/**
 * One-shot week fill: fixtures by date (all leagues) → odds by date → top-15 fixtures → odds fill.
 * Run from backend/:  npm run sync:week-auto
 */
import pool from '../config/database';
import {
  fetchAndStoreLeaguesByIds,
  fetchAndStoreFixtures,
  fetchAndStoreFixturesForRollingWindow,
  fetchAndStoreBulkOddsForRollingWindowByDate,
  getFixtureWindowRange,
} from '../services/apiFootball';
import { runStoragePurge } from '../services/storagePurgeService';
import { TOP_LEAGUES, runOddsSync, ODDS_SYNC_BATCH, getSyncStatus } from '../services/syncService';

const DEFAULT_SEASON = parseInt(
  process.env.FOOTBALL_CURRENT_SEASON || String(new Date().getFullYear()),
  10
);
const TARGET = Math.min(
  5000,
  Math.max(50, parseInt(process.env.SYNC_WEEK_TARGET_FIXTURES || '2000', 10) || 2000)
);
const ODDS_PASSES = Math.min(
  300,
  Math.max(5, parseInt(process.env.SYNC_FILL_ODDS_PASSES || '60', 10) || 60)
);
const BATCH = Math.min(400, ODDS_SYNC_BATCH);

function log(msg: string) {
  console.log(msg);
}

async function windowCounts() {
  const { start, endExclusive } = getFixtureWindowRange();
  const { rows } = await pool.query<{ n: number; with_odds: number }>(
    `SELECT
       COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM odds o WHERE o.fixture_id = f.id))::int AS with_odds
     FROM fixtures f
     WHERE f.match_date >= $1 AND f.match_date < $2`,
    [start, endExclusive]
  );
  return rows[0];
}

async function syncFixturesByDate() {
  log('[sync:week-auto] Phase 1: all fixtures by date (7-day window)');
  const byDate = await fetchAndStoreFixturesForRollingWindow();
  log(`[sync:week-auto] API fixtures by date: ${byDate.fixturesSeen}`);
  const c = await windowCounts();
  log(`[sync:week-auto] Window: ${c.n} fixtures, ${c.with_odds} with odds`);
}

async function syncOddsByDate() {
  log('[sync:week-auto] Phase 2: bulk odds by date');
  const oddsByDate = await fetchAndStoreBulkOddsForRollingWindowByDate();
  log(`[sync:week-auto] Odds bundles from API: ${oddsByDate.oddsRowsSeen}`);
  const c = await windowCounts();
  log(`[sync:week-auto] Window: ${c.n} fixtures, ${c.with_odds} with odds`);
}

async function syncTopLeagueFixtures() {
  log('[sync:week-auto] Phase 3: top-15 league fixtures');
  await fetchAndStoreLeaguesByIds(TOP_LEAGUES);

  for (let i = 0; i < TOP_LEAGUES.length; i++) {
    const apiLeagueId = TOP_LEAGUES[i];
    const leagueRow = await pool.query<{ season_current: string | null; name: string }>(
      'SELECT season_current, name FROM leagues WHERE api_league_id = $1',
      [apiLeagueId]
    );
    const name = leagueRow.rows[0]?.name || `league ${apiLeagueId}`;
    const parsed = leagueRow.rows[0]?.season_current
      ? parseInt(leagueRow.rows[0].season_current, 10)
      : Number.NaN;
    const season = Number.isNaN(parsed) ? DEFAULT_SEASON : parsed;

    log(`[sync:week-auto] [${i + 1}/${TOP_LEAGUES.length}] ${name}`);
    try {
      await fetchAndStoreFixtures(apiLeagueId, season);
    } catch (err) {
      log(`[sync:week-auto] Skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const c = await windowCounts();
    log(`[sync:week-auto] Window: ${c.n} fixtures, ${c.with_odds} with odds`);
  }
}

async function fillOddsUntilTarget() {
  log(`[sync:week-auto] Phase 4: odds fill (target ${TARGET} with odds in window)`);
  let stagnant = 0;

  for (let pass = 0; pass < ODDS_PASSES; pass++) {
    const before = await windowCounts();
    if (before.with_odds >= TARGET) {
      log(`[sync:week-auto] Target reached: ${before.with_odds} with odds`);
      break;
    }
    if (before.n > 0 && before.with_odds >= before.n) {
      log('[sync:week-auto] All window fixtures have odds');
      break;
    }

    const r = await runOddsSync(BATCH);
    if (!('started' in r) || r.started === false) {
      log(`[sync:week-auto] Odds sync skipped: ${JSON.stringify(r)}`);
      break;
    }

    const after = await windowCounts();
    log(
      `[sync:week-auto] pass ${pass + 1}/${ODDS_PASSES}: ${after.n} fixtures, ${after.with_odds} with odds`
    );

    if (after.with_odds >= TARGET) break;

    if (before.with_odds === after.with_odds) {
      stagnant += 1;
      if (stagnant >= 8) {
        log('[sync:week-auto] Odds unchanged for 8 passes; stopping');
        break;
      }
    } else {
      stagnant = 0;
    }
  }
}

async function main() {
  const { start, endExclusive } = getFixtureWindowRange();
  log(`[sync:week-auto] Window: ${start.toISOString()} → ${endExclusive.toISOString()}`);

  await syncFixturesByDate();
  await syncOddsByDate();
  await syncTopLeagueFixtures();
  await fillOddsUntilTarget();
  await runStoragePurge();

  const final = await windowCounts();
  const status = await getSyncStatus();
  log(`[sync:week-auto] Done. Window: ${final.n} fixtures | ${final.with_odds} with odds`);
  log(`[sync:week-auto] DB totals: ${JSON.stringify(status.counts)}`);
  log(`[sync:week-auto] API remaining: ${status.usage.remaining}`);
  await pool.end();
}

main().catch((e) => {
  console.error('[sync:week-auto]', e);
  process.exit(1);
});
