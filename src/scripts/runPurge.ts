import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import pool, { verifyDatabaseConnection } from '../config/database';
import { runStoragePurge } from '../services/storagePurgeService';

async function counts() {
  const { rows } = await pool.query<{
    fixtures: string;
    odds: string;
    odds_history: string;
    live_matches: string;
  }>(`SELECT
      (SELECT COUNT(*)::text FROM fixtures) AS fixtures,
      (SELECT COUNT(*)::text FROM odds) AS odds,
      (SELECT COUNT(*)::text FROM odds_history) AS odds_history,
      (SELECT COUNT(*)::text FROM live_matches) AS live_matches`);
  return rows[0];
}

async function main() {
  console.log('[purge] Connecting to database…');
  await verifyDatabaseConnection();
  console.log('[purge] Connected.');

  const before = await counts();
  console.log('[purge] Before:', before);

  console.log('[purge] Running storage cleanup…');
  const result = await runStoragePurge();
  console.log('[purge] Result:', JSON.stringify(result, null, 2));

  const after = await counts();
  console.log('[purge] After:', after);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[purge] Failed:', err instanceof Error ? err.message : err);
    void pool.end();
    process.exit(1);
  });
