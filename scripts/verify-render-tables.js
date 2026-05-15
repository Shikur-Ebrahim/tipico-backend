/* One-off: node scripts/verify-render-tables.js — uses backend/.env */
require('dotenv').config();
const { Pool } = require('pg');

const u = process.env.DATABASE_URL;
if (!u) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
const useSsl = u.includes('sslmode=require') || process.env.DATABASE_SSL === 'true';
const pool = new Pool({
  connectionString: u,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

const core = [
  'users',
  'wallets',
  'leagues',
  'fixtures',
  'bet_slips',
  'bet_selections',
  'odds',
  'deposit_methods',
  'deposit_requests',
];

async function main() {
  const local = /localhost|127\.0\.0\.1/.test(u);
  console.log('DATABASE_URL is localhost?', local);
  const db = await pool.query('SELECT current_database() AS db');
  console.log('Connected database:', db.rows[0].db);

  const tabs = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const names = new Set(tabs.rows.map((r) => r.tablename));
  console.log('Public table count:', names.size);
  const missing = core.filter((t) => !names.has(t));
  if (missing.length) console.log('Missing core tables:', missing.join(', '));
  else console.log('All checked core tables exist.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
