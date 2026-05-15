import pool from '../config/database';
import {
  getSyncStatus,
  runBootstrapSync,
  runLiveSync,
  runOddsSync,
} from '../services/syncService';

async function main() {
  const action = process.argv[2] || 'status';
  const limitArg = process.argv[3];
  const defaultOddsBatch = parseInt(process.env.ODDS_SYNC_BATCH || '120', 10) || 120;
  const oddsLimit = limitArg ? parseInt(limitArg, 10) : defaultOddsBatch;

  try {
    if (action === 'bootstrap') {
      const result = await runBootstrapSync();
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (action === 'live') {
      const result = await runLiveSync();
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (action === 'odds') {
      const result = await runOddsSync(Number.isNaN(oddsLimit) ? defaultOddsBatch : oddsLimit);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (action === 'status') {
      const result = await getSyncStatus();
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    throw new Error(`Unknown sync action: ${action}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
