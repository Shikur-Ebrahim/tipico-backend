import type { PoolClient } from 'pg';
import pool from '../config/database';

const TICKET_DIGITS = '0123456789';
const TICKET_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Seven characters: T + two digits + two letters + two digits (e.g. T72RE09). */
export function randomTicketCode(): string {
  const d = () => TICKET_DIGITS[Math.floor(Math.random() * 10)];
  const l = () => TICKET_LETTERS[Math.floor(Math.random() * 26)];
  return `T${d()}${d()}${l()}${l()}${d()}${d()}`;
}

export async function allocateUniqueTicketCode(client: PoolClient): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const code = randomTicketCode();
    const dup = await client.query('SELECT 1 FROM bet_slips WHERE ticket_code = $1 LIMIT 1', [code]);
    if (dup.rows.length === 0) return code;
  }
  throw new Error('Could not allocate a unique ticket code');
}

/** Pool-based allocation when not already inside a transaction. */
export async function allocateUniqueTicketCodePool(): Promise<string> {
  const client = await pool.connect();
  try {
    return await allocateUniqueTicketCode(client);
  } finally {
    client.release();
  }
}
