import pool from '../config/database';

export async function ensurePromotionCodesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_promotion_codes (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      code VARCHAR(12) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT user_promotion_codes_phone_unique UNIQUE (phone),
      CONSTRAINT user_promotion_codes_code_unique UNIQUE (code)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_promotion_codes_phone
    ON user_promotion_codes (phone)
  `);
}
