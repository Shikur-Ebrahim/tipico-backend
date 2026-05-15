import cron from 'node-cron';
import {
  fetchAndStoreCountries,
  fetchAndStoreLeagues,
  fetchAndStoreTeams,
  fetchAndStoreOdds,
  fetchAndStoreBulkOdds,
  fetchAndStoreLiveMatches,
  getFootballApiUsage,
  purgeStoredFixturesOutsideWindow,
  getFixtureWindowRange,
  fetchAndStoreFixturesForRollingWindow,
  fetchAndStoreBulkOddsForRollingWindowByDate,
} from './apiFootball';
import { settlePendingBetSlips } from './betSettlementService';
import pool, { verifyDatabaseConnection } from '../config/database';

export const TOP_LEAGUES = [
  39,  // English Premier League
  2,   // UEFA Champions League
  140, // Spanish La Liga
  135, // Italian Serie A
  78,  // German Bundesliga
  61,  // French Ligue 1
  3,   // UEFA Europa League
  848, // UEFA Europa Conference League
  45,  // English FA Cup
  40,  // English Championship
  307, // Saudi Pro League
  253, // Major League Soccer - MLS
  71,  // Brazilian Serie A
  88,  // Dutch Eredivisie
  94   // Portuguese Primeira Liga
];
const DEFAULT_SEASON = parseInt(process.env.FOOTBALL_CURRENT_SEASON || String(new Date().getFullYear()), 10);

export const ODDS_SYNC_BATCH = Math.min(
  400,
  Math.max(20, parseInt(process.env.ODDS_SYNC_BATCH || '120', 10) || 120)
);

/** Parallel API-Football fetches per odds tick (cap avoids rate-limit storms). */
const ODDS_FETCH_CONCURRENCY = Math.min(
  20,
  Math.max(1, parseInt(process.env.ODDS_FETCH_CONCURRENCY || '8', 10) || 8)
);

let fullSyncRunning = false;
let liveSyncRunning = false;
let oddsSyncRunning = false;

type SyncedLeagueRow = {
  api_league_id: number;
  season_current: string | null;
  is_top: boolean;
  name: string;
};

function parseLeagueSeason(seasonCurrent: string | null) {
  const parsed = seasonCurrent ? parseInt(seasonCurrent, 10) : Number.NaN;
  return Number.isNaN(parsed) ? DEFAULT_SEASON : parsed;
}

async function getLeaguesForFixtureSync() {
  const { rows } = await pool.query<SyncedLeagueRow>(
    `SELECT * FROM leagues 
    ORDER BY is_top DESC, top_rank ASC NULLS LAST`
  );

  return rows;
}

export async function runBootstrapSync() {
  if (fullSyncRunning) {
    return { started: false, reason: 'Bootstrap sync already running' };
  }

  fullSyncRunning = true;

  try {
    await fetchAndStoreCountries();
    await fetchAndStoreLeagues(TOP_LEAGUES);

    const byDate = await fetchAndStoreFixturesForRollingWindow();
    console.log(`[SYNC] Fixtures by date (7d): ${byDate.fixturesSeen} rows from API`);

    const oddsByDate = await fetchAndStoreBulkOddsForRollingWindowByDate();
    console.log(`[SYNC] Bulk odds by date (7d): ${oddsByDate.oddsRowsSeen} fixture-odds bundles from API`);

    const leagues = await getLeaguesForFixtureSync();

    const CHUNK_SIZE = 5;
    for (let i = 0; i < leagues.length; i += CHUNK_SIZE) {
      const chunk = leagues.slice(i, i + CHUNK_SIZE);
      console.log(`[SYNC] [${i + 1}-${Math.min(i + CHUNK_SIZE, leagues.length)}/${leagues.length}] Syncing batch...`);
      
      await Promise.all(chunk.map(async (league) => {
        try {
          const season = parseLeagueSeason(league.season_current);
          await fetchAndStoreBulkOdds(league.api_league_id, season);

          if (league.is_top) {
            await fetchAndStoreTeams(league.api_league_id, season);
          }
        } catch (err) {
          console.error(`[SYNC] Failed to sync league ${league.api_league_id}:`, err);
        }
      }));
    }

    await purgeStoredFixturesOutsideWindow();

    return { started: true, completed: true, leagues: leagues.length };
  } finally {
    fullSyncRunning = false;
  }
}

export async function runLiveSync() {
  if (liveSyncRunning) {
    return { started: false, reason: 'Live sync already running' };
  }

  liveSyncRunning = true;

  try {
    await fetchAndStoreLiveMatches();
    try {
      await settlePendingBetSlips();
    } catch (err) {
      console.error('[BET SETTLEMENT] Error after live sync:', err);
    }
    return { started: true, completed: true };
  } finally {
    liveSyncRunning = false;
  }
}

export async function runOddsSync(limit = ODDS_SYNC_BATCH) {
  if (oddsSyncRunning) {
    return { started: false, reason: 'Odds sync already running' };
  }

  oddsSyncRunning = true;

  try {
    const { start, endExclusive } = getFixtureWindowRange();
    const batch = Math.min(400, Math.max(1, limit));

    const fixtures = await pool.query(
      `SELECT f.api_fixture_id 
       FROM fixtures f
       JOIN leagues l ON f.league_id = l.id
       LEFT JOIN odds o ON f.id = o.fixture_id
       WHERE f.api_fixture_id IS NOT NULL
         AND f.match_date >= $2
         AND f.match_date < $3
       GROUP BY f.id, f.api_fixture_id, f.match_date, f.status, l.is_top
       ORDER BY 
         (CASE
           -- In-play: refresh odds often (DB → frontend polling reads this)
           WHEN f.status IN ('1H', '2H', 'HT', 'LIVE', 'ET', 'P')
                AND (MAX(o.last_update) IS NULL OR MAX(o.last_update) < NOW() - INTERVAL '30 seconds')
             THEN 0
           -- Just finished: markets settle / suspend — pull again soon
           WHEN f.status IN ('FT', 'AET', 'PEN')
                AND f.match_date > NOW() - INTERVAL '3 hours'
                AND (MAX(o.last_update) IS NULL OR MAX(o.last_update) < NOW() - INTERVAL '20 seconds')
             THEN 1
           WHEN f.status IN ('1H', '2H', 'HT', 'LIVE', 'ET', 'P') THEN 2
           WHEN MAX(o.id) IS NULL THEN 3
           WHEN f.status = 'NS' THEN 4
           ELSE 5
         END) ASC,
         l.is_top DESC NULLS LAST,
         MAX(o.last_update) NULLS FIRST,
         f.match_date ASC
       LIMIT $1`,
      [batch, start, endExclusive]
    );

    const ids = fixtures.rows.map((row) => row.api_fixture_id as number);
    for (let i = 0; i < ids.length; i += ODDS_FETCH_CONCURRENCY) {
      const chunk = ids.slice(i, i + ODDS_FETCH_CONCURRENCY);
      await Promise.all(chunk.map((apiFixtureId) => fetchAndStoreOdds(apiFixtureId)));
    }

    try {
      await settlePendingBetSlips();
    } catch (err) {
      console.error('[BET SETTLEMENT] Error after odds sync:', err);
    }

    return { started: true, completed: true, fixtures: fixtures.rowCount };
  } finally {
    oddsSyncRunning = false;
  }
}

export async function getSyncStatus() {
  const usage = await getFootballApiUsage();
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM countries) AS countries,
       (SELECT COUNT(*) FROM leagues) AS leagues,
       (SELECT COUNT(*) FROM teams) AS teams,
       (SELECT COUNT(*) FROM fixtures) AS fixtures,
       (SELECT COUNT(*) FROM odds) AS odds,
       (SELECT COUNT(*) FROM live_matches WHERE is_active = true) AS live_matches`
  );

  return {
    season: DEFAULT_SEASON,
    topLeagues: TOP_LEAGUES,
    usage,
    jobs: {
      fullSyncRunning,
      liveSyncRunning,
      oddsSyncRunning,
    },
    counts: counts.rows[0],
  };
}

function isDatabaseConnectivityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('connection timeout') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('Connection terminated') ||
    msg.includes('getaddrinfo')
  );
}

export function startSyncJobs() {
  void (async () => {
    try {
      await verifyDatabaseConnection();
    } catch (err) {
      console.error(
        '[SYNC] PostgreSQL is not reachable. Skipping initial bootstrap until the database is available.'
      );
      console.error(
        '[SYNC] Check: PostgreSQL is running, port in .env matches the server (default 5432), and DATABASE_URL or DB_HOST / DB_USER / DB_PASSWORD / DB_NAME are correct.'
      );
      if (err instanceof Error && err.message) {
        console.error('[SYNC] Underlying error:', err.message);
      }
      return;
    }

    try {
      await runBootstrapSync();
    } catch (err) {
      if (isDatabaseConnectivityError(err)) {
        console.error('[SYNC] Initial bootstrap failed: lost database connection during sync.');
        console.error('[SYNC]', err instanceof Error ? err.message : err);
      } else {
        console.error('[SYNC] Initial bootstrap error:', err);
      }
    }
  })();

  cron.schedule('0 3 * * *', async () => {
    try {
      await runBootstrapSync();
    } catch (err) {
      console.error('[SYNC] Error:', err);
    }
  });

  // Re-pull fixtures by date into the DB between full bootstraps (frontend reads DB only).
  // Set ROLLING_FIXTURE_REFRESH=0 to disable. Default: every 6 hours at :12.
  const rollingRefreshOff =
    process.env.ROLLING_FIXTURE_REFRESH === '0' ||
    process.env.ROLLING_FIXTURE_REFRESH === 'false' ||
    process.env.ROLLING_FIXTURE_REFRESH === 'no';
  if (!rollingRefreshOff) {
    cron.schedule('12 */6 * * *', async () => {
      try {
        const r = await fetchAndStoreFixturesForRollingWindow();
        await purgeStoredFixturesOutsideWindow();
        console.log(
          `[SYNC] Rolling fixture refresh done (API rows seen: ${r.fixturesSeen}, window days: ${r.days})`
        );
      } catch (err) {
        console.error('[SYNC] Rolling fixture refresh error:', err);
      }
    });
  }

  // Every 30s so scores / FT status reach the DB faster than a 1-minute tick
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await runLiveSync();
    } catch (err) {
      console.error('[LIVE SYNC] Error:', err);
    }
  });

  // Odds only via backend → DB; frontend reads DB. Run often so live / FT odds land quickly.
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await runOddsSync(ODDS_SYNC_BATCH);
    } catch (err) {
      console.error('[ODDS SYNC] Error:', err);
    }
  });

  console.log('[SYNC] Cron jobs scheduled.');
}
