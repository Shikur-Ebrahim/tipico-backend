import pool from '../config/database';

export const WITHDRAWAL_MIN_DEPOSIT_KEY = 'withdrawal_min_total_deposit';
export const DEFAULT_MIN_TOTAL_DEPOSIT = 6665;

/** Ensures `app_settings` exists and seeds default withdrawal deposit rule. */
export async function ensureAppSettings(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [WITHDRAWAL_MIN_DEPOSIT_KEY, JSON.stringify({ amount: DEFAULT_MIN_TOTAL_DEPOSIT })]
  );
}
