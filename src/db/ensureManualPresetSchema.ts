import pool from '../config/database';

async function tryQuery(sql: string): Promise<void> {
  try {
    await pool.query(sql);
  } catch (e) {
    console.warn('[DB] ensureManualPresetSchema optional SQL skipped:', (e as Error)?.message || e);
  }
}

/** Idempotent columns for admin-built manual preset tickets (no real fixture rows). */
export async function ensureManualPresetSchema(): Promise<void> {
  await pool.query(`ALTER TABLE bet_slips ADD COLUMN IF NOT EXISTS is_manual_preset BOOLEAN DEFAULT FALSE`);
  await pool.query(
    `ALTER TABLE bet_selections ADD COLUMN IF NOT EXISTS manual_kickoff_at TIMESTAMPTZ`
  );
  await pool.query(`ALTER TABLE bet_selections ADD COLUMN IF NOT EXISTS manual_end_at TIMESTAMPTZ`);
  await pool.query(
    `ALTER TABLE bet_selections ADD COLUMN IF NOT EXISTS is_manual_fixture BOOLEAN DEFAULT FALSE`
  );
  await pool.query(`ALTER TABLE bet_slips ALTER COLUMN user_id DROP NOT NULL`);
  /** Preset combined odds can exceed DECIMAL(5,2) (e.g. 5×5×5). */
  await tryQuery(`ALTER TABLE bet_slips ALTER COLUMN total_odds TYPE DECIMAL(14, 4)`);
}
