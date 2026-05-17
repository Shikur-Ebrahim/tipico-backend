/**
 * Fast 7-day fill: top leagues only (~150–250 fixtures), not global fixtures-by-date.
 * Run from backend/:  npm run sync:top-week
 */
import pool from '../config/database';
import {
  fetchAndStoreCountries,
  fetchAndStoreLeagues,
  fetchAndStoreFixtures,
  fetchAndStoreBulkOdds,
  getFixtureWindowRange,
} from '../services/apiFootball';
import { runStoragePurge } from '../services/storagePurgeService';
import { TOP_LEAGUES } from '../services/syncService';

const DEFAULT_SEASON = parseInt(
  process.env.FOOTBALL_CURRENT_SEASON || String(new Date().getFullYear()),
  10
);

async function countInWindow() {
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

async function ensureTopLeaguesInDb() {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM leagues WHERE api_league_id = ANY($1::int[])`,
    [TOP_LEAGUES]
  );
  if (rows[0].n >= TOP_LEAGUES.length) {
    console.log('[sync:top-week] Top leagues already in DB — skipping /countries and /leagues API calls.');
    return;
  }
  console.log('[sync:top-week] Seeding countries + leagues (one-time, slow API call)...');
  await fetchAndStoreCountries();
  await fetchAndStoreLeagues(TOP_LEAGUES);
}

async function main() {
  console.log('[sync:top-week] Top leagues:', TOP_LEAGUES.length, 'default season:', DEFAULT_SEASON);

  await ensureTopLeaguesInDb();

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

    console.log(`[sync:top-week] [${i + 1}/${TOP_LEAGUES.length}] ${name} (${apiLeagueId}) season ${season}`);
    try {
      await fetchAndStoreFixtures(apiLeagueId, season);
      await fetchAndStoreBulkOdds(apiLeagueId, season);
    } catch (err) {
      console.warn(
        `[sync:top-week] Skipped ${name}:`,
        err instanceof Error ? err.message : err
      );
    }
    const c = await countInWindow();
    console.log(`[sync:top-week] Window so far: ${c.n} fixtures, ${c.with_odds} with odds`);
  }

  await runStoragePurge();
  const final = await countInWindow();
  console.log('[sync:top-week] Done. Fixtures in 7-day window:', final.n, '| with odds:', final.with_odds);
  await pool.end();
}

main().catch((e) => {
  console.error('[sync:top-week]', e);
  process.exit(1);
});
