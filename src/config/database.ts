import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const connectionTimeoutMillis = parseInt(
  process.env.DB_CONNECTION_TIMEOUT_MS || '15000',
  10
);

const poolMax = Math.min(
  20,
  Math.max(2, parseInt(process.env.DB_POOL_MAX || (process.env.NODE_ENV === 'production' ? '8' : '20'), 10) || 8)
);

const basePoolConfig = {
  max: poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis)
    ? connectionTimeoutMillis
    : 15000,
  keepAlive: true,
};

const databaseUrl = process.env.DATABASE_URL || '';
/** Render Postgres requires TLS; URL usually includes sslmode=require — enable SSL if missing. */
const useSsl =
  process.env.DATABASE_SSL === 'true' ||
  databaseUrl.includes('sslmode=require') ||
  (databaseUrl.includes('render.com') && process.env.DATABASE_SSL !== 'false');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
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
  console.error('Unexpected error on idle client', err);
});

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
