import pool from '../config/database';

async function tryQuery(sql: string): Promise<void> {
  try {
    await pool.query(sql);
  } catch (e) {
    console.warn('[DB] ensureBetSlipSchema optional SQL skipped:', (e as Error)?.message || e);
  }
}

/** All columns required by bet placement, history, and ticket lookup. */
export async function ensureBetSlipSchema(): Promise<void> {
  await pool.query(`ALTER TABLE bet_slips ADD COLUMN IF NOT EXISTS ticket_code VARCHAR(50)`);
  await pool.query(
    `ALTER TABLE bet_slips ADD COLUMN IF NOT EXISTS is_manual_preset BOOLEAN DEFAULT FALSE`
  );

  await pool.query(`
    ALTER TABLE bet_selections
      ADD COLUMN IF NOT EXISTS home_team VARCHAR(150),
      ADD COLUMN IF NOT EXISTS away_team VARCHAR(150),
      ADD COLUMN IF NOT EXISTS home_logo TEXT,
      ADD COLUMN IF NOT EXISTS away_logo TEXT,
      ADD COLUMN IF NOT EXISTS league_name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS market_name VARCHAR(150)
  `);
  await pool.query(
    `ALTER TABLE bet_selections ADD COLUMN IF NOT EXISTS manual_kickoff_at TIMESTAMPTZ`
  );
  await pool.query(`ALTER TABLE bet_selections ADD COLUMN IF NOT EXISTS manual_end_at TIMESTAMPTZ`);
  await pool.query(
    `ALTER TABLE bet_selections ADD COLUMN IF NOT EXISTS is_manual_fixture BOOLEAN DEFAULT FALSE`
  );

  await tryQuery(`ALTER TABLE bet_slips ALTER COLUMN user_id DROP NOT NULL`);
  await tryQuery(`ALTER TABLE bet_slips ALTER COLUMN total_odds TYPE DECIMAL(14, 4)`);

  await tryQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bet_slips_ticket_code
    ON bet_slips(ticket_code) WHERE ticket_code IS NOT NULL
  `);
}
