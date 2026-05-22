import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─── Connection timeout ────────────────────────────────────────────────────
// How long pg-pool waits for a free slot before throwing
// "timeout exceeded when trying to connect".
// Default 30 s gives background jobs time to release connections.
const connectionTimeoutMillis = (() => {
  const v = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '30000', 10);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();

// ─── Pool size ─────────────────────────────────────────────────────────────
// Render free PostgreSQL allows ≤ 25 simultaneous connections.
// Keep the app pool small so cron jobs, HTTP handlers, and any other
// Render services don't fight over the hard limit.
// Override with DB_POOL_MAX env var if needed.
const poolMax = (() => {
  const envVal = parseInt(
    process.env.DB_POOL_MAX ||
      (process.env.NODE_ENV === 'production' ? '5' : '15'),
    10
  );
  const n = Number.isFinite(envVal) ? envVal : 5;
  return Math.min(15, Math.max(2, n));
})();

// ─── SSL ───────────────────────────────────────────────────────────────────
const databaseUrl = process.env.DATABASE_URL || '';
const useSsl =
  process.env.DATABASE_SSL === 'true' ||
  databaseUrl.includes('sslmode=require') ||
  (databaseUrl.includes('render.com') && process.env.DATABASE_SSL !== 'false');

// ─── Pool ──────────────────────────────────────────────────────────────────
const basePoolConfig = {
  max: poolMax,
  // Release idle connections after 60 s so we don't hold slots needlessly.
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis,
  // TCP keep-alive prevents the load-balancer from silently dropping
  // long-idle connections that the pool thinks are still valid.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  // Allow the process to exit even if idle clients remain in the pool.
  allowExitOnIdle: true,
};

const pool =
  databaseUrl
    ? new Pool({
        connectionString: databaseUrl,
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
        ...basePoolConfig,
      })
    : new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'betting_db',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
        ...basePoolConfig,
      });

pool.on('error', (err: Error) => {
  // Log but never crash the process — pg-pool will attempt a new
  // connection on the next query.
  console.error('[DB] Unexpected error on idle client:', err.message);
});

// ─── Health check ──────────────────────────────────────────────────────────
export async function verifyDatabaseConnection(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

export default pool;
