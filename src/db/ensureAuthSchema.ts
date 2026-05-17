import pool from '../config/database';

/** Indexes so login/signup lookups stay fast as user count grows. */
export async function ensureAuthSchema(): Promise<void> {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets (user_id)
  `);
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users (phone)
    `);
  } catch (err) {
    console.warn('[auth] unique phone index not applied (duplicate phones may exist):', err);
  }
}
