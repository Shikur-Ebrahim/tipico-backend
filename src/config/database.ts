import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const connectionTimeoutMillis = parseInt(
  process.env.DB_CONNECTION_TIMEOUT_MS || '15000',
  10
);

const basePoolConfig = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis)
    ? connectionTimeoutMillis
    : 15000,
  keepAlive: true,
};

const useSsl =
  process.env.DATABASE_SSL === 'true' ||
  (process.env.DATABASE_URL?.includes('sslmode=require') ?? false);

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
