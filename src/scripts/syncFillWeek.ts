/**
 * One-shot: full bootstrap (7-day fixture window + bulk odds) then many odds passes
 * until fixtures are covered or progress stalls. Run from backend/:
 *
 *   ODDS_SYNC_BATCH=400 SYNC_FILL_ODDS_PASSES=250 npm run sync:fill-week
 *
 * Uses DATABASE_URL from .env. Consumes API-Football quota; do not run endlessly on free tier.
 */
import pool from '../config/database';
import { runBootstrapSync, runOddsSync, ODDS_SYNC_BATCH, getSyncStatus } from '../services/syncService';

const PASSES = Math.min(
  500,
  Math.max(1, parseInt(process.env.SYNC_FILL_ODDS_PASSES || '200', 10) || 200)
);
const BATCH = Math.min(400, ODDS_SYNC_BATCH);

async function counts() {
  const { rows } = await pool.query<{ fixtures: string; with_odds: string }>(
    `SELECT
      (SELECT COUNT(*)::text FROM fixtures) AS fixtures,
      (SELECT COUNT(*)::text FROM fixtures f WHERE EXISTS (SELECT 1 FROM odds o WHERE o.fixture_id = f.id)) AS with_odds`
  );
  return {
    fixtures: parseInt(rows[0].fixtures, 10),
    with_odds: parseInt(rows[0].with_odds, 10),
  };
}

async function main() {
  console.log('[sync:fill-week] ODDS_SYNC_BATCH=', BATCH, 'max passes=', PASSES);
  console.log('[sync:fill-week] Starting bootstrap...');
  const boot = await runBootstrapSync();
  console.log('[sync:fill-week] Bootstrap:', boot);

  let stagnant = 0;

  for (let i = 0; i < PASSES; i++) {
    const before = await counts();
    const r = await runOddsSync(BATCH);
    if (!('started' in r) || r.started === false) {
      console.log('[sync:fill-week] Odds sync skipped:', r);
      break;
    }
    const after = await counts();
    const batchRows = 'fixtures' in r ? Number(r.fixtures) : 0;
    console.log(
      `[sync:fill-week] odds ${i + 1}/${PASSES} fixtures=${after.fixtures} with_odds=${after.with_odds} batchRows=${batchRows}`
    );

    if (after.fixtures > 0 && after.with_odds >= after.fixtures) {
      console.log('[sync:fill-week] All fixtures have at least one odds row.');
      break;
    }

    if (after.fixtures > 0 && before.with_odds === after.with_odds) {
      stagnant += 1;
      if (stagnant >= 12) {
        console.log('[sync:fill-week] with_odds unchanged for 12 passes; stopping.');
        break;
      }
    } else {
      stagnant = 0;
    }
  }

  const status = await getSyncStatus();
  console.log('[sync:fill-week] API usage:', status.usage);
  console.log('[sync:fill-week] Final counts:', status.counts);
  await pool.end();
}

main().catch((e) => {
  console.error('[sync:fill-week]', e);
  process.exit(1);
});
