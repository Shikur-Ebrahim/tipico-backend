/**
 * One-shot: promote user to admin (optional password reset).
 * Do not commit secrets. Run from backend/:
 *
 * Promote only (keep existing signup password):
 *   $env:SET_ADMIN_PHONE="912123432"
 *   node scripts/set-admin-once.js
 *
 * Promote + set new password:
 *   $env:SET_ADMIN_PHONE="912123432"
 *   $env:SET_ADMIN_PASSWORD="new-password"
 *   node scripts/set-admin-once.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function phoneCandidates(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const set = new Set([s]);
  if (/^\d{9}$/.test(s) && s.startsWith('9')) {
    set.add(`+251${s}`);
    set.add(`251${s}`);
  }
  return [...set];
}

async function main() {
  const rawPhone = process.env.SET_ADMIN_PHONE;
  if (!rawPhone || !String(rawPhone).trim()) {
    console.error('Set SET_ADMIN_PHONE in the environment (not in .env).');
    process.exit(1);
  }

  const password = process.env.SET_ADMIN_PASSWORD;
  const changePassword = Boolean(password && String(password).length > 0);

  const u = process.env.DATABASE_URL;
  if (!u) {
    console.error('DATABASE_URL missing in backend/.env');
    process.exit(1);
  }
  const useSsl = u.includes('sslmode=require') || process.env.DATABASE_SSL === 'true';
  const pool = new Pool({
    connectionString: u,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  const phones = phoneCandidates(rawPhone);
  const find = await pool.query(
    `SELECT id, phone, role FROM users WHERE phone = ANY($1::text[]) LIMIT 1`,
    [phones]
  );

  if (find.rows.length === 0) {
    if (!changePassword) {
      console.error('No user found for that phone. Register first, or set SET_ADMIN_PASSWORD to create a new admin.');
      await pool.end();
      process.exit(1);
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const phone = phones.includes(rawPhone.trim()) ? rawPhone.trim() : phones[0];
      const ins = await client.query(
        `INSERT INTO users (phone, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id, phone`,
        [phone, passwordHash]
      );
      const id = ins.rows[0].id;
      const w = await client.query('SELECT id FROM wallets WHERE user_id = $1', [id]);
      if (w.rows.length === 0) {
        await client.query(
          `INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, 'ETB')`,
          [id]
        );
      }
      await client.query('COMMIT');
      console.log('Created new admin user:', ins.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      process.exit(1);
    } finally {
      client.release();
    }
  } else {
    const row = find.rows[0];
    if (changePassword) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      await pool.query(`UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2`, [
        passwordHash,
        row.id,
      ]);
      console.log('Updated user to admin (password reset):', {
        id: row.id,
        phone: row.phone,
        wasRole: row.role,
      });
    } else {
      await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [row.id]);
      console.log('Updated user to admin (password unchanged):', {
        id: row.id,
        phone: row.phone,
        wasRole: row.role,
      });
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
