import pool from '../config/database';

/** Ensures `withdrawal_methods` exists (matches admin route bootstrap). */
export async function ensureWithdrawalMethodsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_methods (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      type VARCHAR(50),
      logo_url TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

export async function ensureWithdrawalSchema(): Promise<void> {
  await ensureWithdrawalMethodsTable();
  await ensureWithdrawalRequestsTable();
}

/** Ensures `withdrawal_requests` exists (idempotent). Safe to call on each relevant request. */
export async function ensureWithdrawalRequestsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method_id INT,
      amount NUMERIC(12,2) NOT NULL,
      account_name VARCHAR(200),
      account_details TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'
  `);
  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await pool.query(`UPDATE withdrawal_requests SET status = 'pending' WHERE status IS NULL OR status = ''`);
}
