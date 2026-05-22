import cron from 'node-cron';
import {
  fetchAndStoreCountries,
  fetchAndStoreLeagues,
  fetchAndStoreTeams,
  fetchAndStoreOdds,
  fetchAndStoreBulkOdds,
  fetchAndStoreLiveMatches,
  getFootballApiUsage,
  getFixtureWindowRange,
  fetchAndStoreFixturesForRollingWindow,
  fetchAndStoreBulkOddsForRollingWindowByDate,
  fetchAndStoreLeaguesByIds,
  fetchAndStoreFixtures,
} from './apiFootball';
import { purgeFinishedOddsAndLiveData, runStoragePurge } from './storagePurgeService';
import { settlePendingBetSlips } from './betSettlementService';
import pool, { verifyDatabaseConnection } from '../config/database';
import { sqlFixtureHasDisplayableOdds } from '../utils/displayableOdds';
import { isTransientDbError } from '../utils/dbRetry';

// ─── DB Circuit Breaker ───────────────────────────────────────────────────────
// When the database is unreachable, heavy background jobs will only make things
// worse by queuing up more connections. The circuit breaker pauses all cron
// work for CIRCUIT_BREAKER_COOLDOWN_MS after consecutive failures, then probes
// again with a lightweight SELECT 1 before re-enabling.
const CIRCUIT_BREAKER_THRESHOLD = 3;      // consecutive failures before opening
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000; // 60 s cool-down before re-probe

let _cbFailures = 0;
let _cbOpenUntil = 0; // epoch ms — circuit stays open until this timestamp

function circuitBreakerOpen(): boolean {
  return Date.now() < _cbOpenUntil;
}

function recordDbSuccess(): void {
  _cbFailures = 0;
  _cbOpenUntil = 0;
}

function recordDbFailure(err: unknown): void {
  if (!isTransientDbError(err)) return; // only connectivity errors trip the breaker
  _cbFailures += 1;
  if (_cbFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    _cbOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn(
      `[DB CIRCUIT BREAKER] Opened for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s ` +
        `after ${_cbFailures} consecutive transient errors.`
    );
  }
}

/** Run `fn` only if the circuit breaker is closed (DB is healthy). */
async function withCircuitBreaker<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (circuitBreakerOpen()) {
    console.log(`[${label}] Skipped — DB circuit breaker is open, waiting for recovery.`);
    return undefined;
  }
  try {
    const result = await fn();
    recordDbSuccess();
    return result;
  } catch (err) {
    recordDbFailure(err);
    throw err;
  }
}

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
let liveOddsSyncRunning = false;
let oddsSyncRunning = false;
let rollingFillRunning = false;

const ROLLING_FILL_TARGET = Math.min(
  5000,
  Math.max(50, parseInt(process.env.SYNC_WEEK_TARGET_FIXTURES || '5000', 10) || 5000)
);
const ROLLING_FILL_ODDS_PASSES = Math.min(
  120,
  Math.max(5, parseInt(process.env.SYNC_FILL_ODDS_PASSES || '40', 10) || 40)
);

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

    await runStoragePurge();

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

/**
 * Sync odds for every active live match (API-Football → DB).
 * Runs after live fixture sync so live_matches is current. Frontend only reads DB.
 */
export async function runLiveOddsSync() {
  if (liveOddsSyncRunning) {
    return { started: false, reason: 'Live odds sync already running' };
  }

  liveOddsSyncRunning = true;

  try {
    const { rows } = await pool.query<{ api_fixture_id: number }>(
      `SELECT f.api_fixture_id
       FROM live_matches lm
       JOIN fixtures f ON f.id = lm.fixture_id
       WHERE lm.is_active = true
         AND f.api_fixture_id IS NOT NULL
         AND f.status NOT IN ('FT', 'AET', 'PEN')`
    );

    const ids = rows.map((row) => row.api_fixture_id);
    if (ids.length === 0) {
      return { started: true, completed: true, fixtures: 0 };
    }

    for (let i = 0; i < ids.length; i += ODDS_FETCH_CONCURRENCY) {
      const chunk = ids.slice(i, i + ODDS_FETCH_CONCURRENCY);
      await Promise.all(chunk.map((apiFixtureId) => fetchAndStoreOdds(apiFixtureId)));
    }

    return { started: true, completed: true, fixtures: ids.length };
  } finally {
    liveOddsSyncRunning = false;
  }
}

async function countWindowFixturesWithOdds(): Promise<{ total: number; withOdds: number }> {
  const { start, endExclusive } = getFixtureWindowRange();
  const displayableSql = sqlFixtureHasDisplayableOdds('f');
  const { rows } = await pool.query<{ n: number; with_odds: number }>(
    `SELECT
       COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE ${displayableSql})::int AS with_odds
     FROM fixtures f
     WHERE f.match_date >= $1 AND f.match_date < $2`,
    [start, endExclusive]
  );
  return { total: rows[0]?.n ?? 0, withOdds: rows[0]?.with_odds ?? 0 };
}

/** Fill odds in the 7-day window until SYNC_WEEK_TARGET_FIXTURES (default 5000) have displayable odds. */
export async function runRollingOddsFill() {
  if (rollingFillRunning) {
    return { started: false, reason: 'Rolling odds fill already running' };
  }
  rollingFillRunning = true;
  const batch = Math.min(400, ODDS_SYNC_BATCH);
  let stagnant = 0;

  try {
    console.log(
      `[SYNC] Rolling odds fill started (target ${ROLLING_FILL_TARGET} with odds, up to ${ROLLING_FILL_ODDS_PASSES} passes)`
    );

    for (let pass = 0; pass < ROLLING_FILL_ODDS_PASSES; pass++) {
      const before = await countWindowFixturesWithOdds();
      if (before.withOdds >= ROLLING_FILL_TARGET) {
        console.log(`[SYNC] Rolling fill target reached: ${before.withOdds} fixtures with odds`);
        return { started: true, completed: true, withOdds: before.withOdds };
      }
      if (before.total > 0 && before.withOdds >= before.total) {
        console.log(`[SYNC] All ${before.total} window fixtures already have odds`);
        return { started: true, completed: true, withOdds: before.withOdds };
      }

      const r = await runOddsSync(batch);
      if (!('started' in r) || r.started === false) {
        console.log(`[SYNC] Rolling fill stopped: ${JSON.stringify(r)}`);
        break;
      }

      const after = await countWindowFixturesWithOdds();
      console.log(
        `[SYNC] Rolling fill pass ${pass + 1}/${ROLLING_FILL_ODDS_PASSES}: ${after.withOdds}/${after.total} with odds`
      );

      if (after.withOdds >= ROLLING_FILL_TARGET) {
        return { started: true, completed: true, withOdds: after.withOdds };
      }

      if (before.withOdds === after.withOdds) {
        stagnant += 1;
        if (stagnant >= 8) {
          console.log('[SYNC] Rolling fill: no progress for 8 passes; stopping');
          break;
        }
      } else {
        stagnant = 0;
      }
    }

    const final = await countWindowFixturesWithOdds();
    return { started: true, completed: true, withOdds: final.withOdds };
  } finally {
    rollingFillRunning = false;
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

    const displayableSql = sqlFixtureHasDisplayableOdds('f');
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
           WHEN NOT (${displayableSql}) THEN 0
           WHEN EXISTS (
             SELECT 1 FROM live_matches lm
             WHERE lm.fixture_id = f.id AND lm.is_active = true
           )
           AND (MAX(o.last_update) IS NULL OR MAX(o.last_update) < NOW() - INTERVAL '30 seconds')
             THEN 1
           WHEN f.status IN ('1H', '2H', 'HT', 'LIVE', 'ET', 'P')
                AND (MAX(o.last_update) IS NULL OR MAX(o.last_update) < NOW() - INTERVAL '30 seconds')
             THEN 2
           WHEN f.status IN ('FT', 'AET', 'PEN')
                AND f.match_date > NOW() - INTERVAL '3 hours'
                AND (MAX(o.last_update) IS NULL OR MAX(o.last_update) < NOW() - INTERVAL '20 seconds')
             THEN 3
           WHEN f.status IN ('1H', '2H', 'HT', 'LIVE', 'ET', 'P') THEN 4
           WHEN MAX(o.id) IS NULL THEN 5
           WHEN f.status = 'NS' THEN 6
           ELSE 7
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

    // NOTE: settlePendingBetSlips is intentionally NOT called here.
    // It is already called inside runLiveSync (every 30 s) to avoid
    // running the settlement twice per 30-second window and doubling
    // the DB connection pressure from the per-slip transactions.

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
      liveOddsSyncRunning,
      oddsSyncRunning,
    },
    counts: counts.rows[0],
  };
}

function isDatabaseConnectivityError(err: unknown): boolean {
  return isTransientDbError(err);
}

function shouldRunBootstrapOnStart(): boolean {
  const v = process.env.RUN_BOOTSTRAP_ON_START;
  if (v === '0' || v === 'false' || v === 'no') return false;
  /** Default on: 7-day fixtures + odds fill on startup (set RUN_BOOTSTRAP_ON_START=0 to disable). */
  return true;
}

function shouldRunRollingFillOnStart(): boolean {
  const v = process.env.RUN_ROLLING_FILL_ON_START;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
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

    if (shouldRunBootstrapOnStart()) {
      try {
        await runBootstrapSync();
        if (shouldRunRollingFillOnStart()) {
          void runRollingOddsFill().catch((err) =>
            console.error('[SYNC] Post-bootstrap rolling odds fill error:', err)
          );
        }
      } catch (err) {
        if (isDatabaseConnectivityError(err)) {
          console.error('[SYNC] Initial bootstrap failed: lost database connection during sync.');
          console.error('[SYNC]', err instanceof Error ? err.message : err);
        } else {
          console.error('[SYNC] Initial bootstrap error:', err);
        }
      }
    } else {
      console.log('[SYNC] Skipping startup bootstrap (RUN_BOOTSTRAP_ON_START=0).');
      if (shouldRunRollingFillOnStart()) {
        void runRollingOddsFill().catch((err) =>
          console.error('[SYNC] Startup rolling odds fill error:', err)
        );
      }
    }
  })();

  // ── Nightly full bootstrap: countries, leagues, fixtures, bulk odds (03:00 UTC) ──
  cron.schedule('0 3 * * *', async () => {
    await withCircuitBreaker('SYNC/bootstrap', async () => {
      try {
        await runBootstrapSync();
        await runRollingOddsFill();
      } catch (err) {
        console.error('[SYNC] Error:', err);
        throw err;
      }
    });
  });

  // ── Top-up odds (toward 5 000 fixture target) every 4 hours ──────────────
  cron.schedule('0 */4 * * *', async () => {
    await withCircuitBreaker('SYNC/rolling-fill', async () => {
      try {
        await runRollingOddsFill();
      } catch (err) {
        console.error('[SYNC] Rolling odds fill error:', err);
        throw err;
      }
    });
  });

  // ── Re-pull fixtures by date every 6 hours at :12 ────────────────────────
  const rollingRefreshOff =
    process.env.ROLLING_FIXTURE_REFRESH === '0' ||
    process.env.ROLLING_FIXTURE_REFRESH === 'false' ||
    process.env.ROLLING_FIXTURE_REFRESH === 'no';
  if (!rollingRefreshOff) {
    cron.schedule('12 */6 * * *', async () => {
      await withCircuitBreaker('SYNC/rolling-fixture', async () => {
        try {
          const r = await fetchAndStoreFixturesForRollingWindow();
          await runStoragePurge();
          console.log(
            `[SYNC] Rolling fixture refresh done (API rows seen: ${r.fixturesSeen}, window days: ${r.days})`
          );
        } catch (err) {
          console.error('[SYNC] Rolling fixture refresh error:', err);
          throw err;
        }
      });
    });
  }

  // ── Live scores + bet settlement every 30 s (fires at second :00 and :30) ─
  // Separated from odds-sync so they don't compete for the same pool slots.
  cron.schedule('*/30 * * * * *', async () => {
    await withCircuitBreaker('LIVE SYNC', async () => {
      try {
        await runLiveSync();      // fetches live scores + settles bets
        await runLiveOddsSync(); // fetches live odds only
      } catch (err) {
        console.error('[LIVE SYNC] Error:', err);
        throw err;
      }
    });
  });

  // ── General odds backlog fill — STAGGERED to second :15 and :45 ───────────
  // By offsetting 15 s from the live-sync cron we halve the peak connection
  // demand and avoid both jobs racing for the same pool slots simultaneously.
  cron.schedule('15-59/30 * * * * *', async () => {
    await withCircuitBreaker('ODDS SYNC', async () => {
      try {
        await runOddsSync(ODDS_SYNC_BATCH);
      } catch (err) {
        console.error('[ODDS SYNC] Error:', err);
        throw err;
      }
    });
  });

  // ── Storage purge: old odds + finished fixtures every hour at :20 ─────────
  cron.schedule('20 * * * *', async () => {
    await withCircuitBreaker('PURGE/storage', async () => {
      try {
        await runStoragePurge();
      } catch (err) {
        console.error('[PURGE] Storage cleanup error:', err);
        throw err;
      }
    });
  });

  // ── Light purge: FT odds every 30 min at :05 and :35 (offset from others) ─
  cron.schedule('5-59/30 * * * *', async () => {
    await withCircuitBreaker('PURGE/finished-odds', async () => {
      try {
        await purgeFinishedOddsAndLiveData();
      } catch (err) {
        console.error('[PURGE] Finished odds cleanup error:', err);
        throw err;
      }
    });
  });

  console.log('[SYNC] Cron jobs scheduled.');
}

export { runStoragePurge };
