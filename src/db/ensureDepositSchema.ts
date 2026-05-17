import pool from '../config/database';

export async function ensureDepositSchema(): Promise<void> {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposit_requests_user_pending
    ON deposit_requests (user_id)
    WHERE status = 'pending'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposit_methods_active
    ON deposit_methods (name)
    WHERE active = true
  `);
}
