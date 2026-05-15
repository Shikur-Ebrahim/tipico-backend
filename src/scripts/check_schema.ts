import pool from '../config/database';

async function check() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'bet_selections';
    `);
    console.log('bet_selections schema:', JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Check failed:', err);
  } finally {
    client.release();
    process.exit();
  }
}

check();
