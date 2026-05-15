/**
 * Applies src/db/schema.sql + required extras to the DB in DATABASE_URL.
 * Run from repo root: node backend/scripts/apply-cloud-bootstrap.js
 * Or from backend/: node scripts/apply-cloud-bootstrap.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
});

const u = process.env.DATABASE_URL;
if (!u) {
  console.error('Set DATABASE_URL in backend/.env');
  process.exit(1);
}
const useSsl = u.includes('sslmode=require') || process.env.DATABASE_SSL === 'true';
const pool = new Pool({
  connectionString: u,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

const EXTRA_SQL = `
ALTER TABLE bet_slips ADD COLUMN IF NOT EXISTS ticket_code VARCHAR(50);
ALTER TABLE bet_selections
  ADD COLUMN IF NOT EXISTS home_team VARCHAR(150),
  ADD COLUMN IF NOT EXISTS away_team VARCHAR(150),
  ADD COLUMN IF NOT EXISTS home_logo TEXT,
  ADD COLUMN IF NOT EXISTS away_logo TEXT,
  ADD COLUMN IF NOT EXISTS league_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS market_name VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

CREATE TABLE IF NOT EXISTS deposit_methods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  logo_url TEXT,
  min_amount DECIMAL(10,2) DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE deposit_methods ADD COLUMN IF NOT EXISTS account_details TEXT;
ALTER TABLE deposit_methods ADD COLUMN IF NOT EXISTS account_name VARCHAR(200);

CREATE TABLE IF NOT EXISTS deposit_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method_id INT REFERENCES deposit_methods(id),
  amount NUMERIC(12,2) NOT NULL,
  screenshot_url TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawal_methods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  type VARCHAR(50),
  logo_url TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

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
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bet_slips_ticket_code ON bet_slips(ticket_code) WHERE ticket_code IS NOT NULL;
`;

async function main() {
  const schemaPath = path.resolve(__dirname, '../src/db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    console.log('Applying schema.sql ...');
    await client.query(sql);
    console.log('Applying extras (ticket_code, deposits, role) ...');
    await client.query(EXTRA_SQL);
    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
