const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'betting_db',
  password: 'shikur3828', // Adjust if different
  port: 5432,
});

async function checkFixtures() {
  try {
    const res = await pool.query(`
      SELECT match_date::date as date, COUNT(DISTINCT f.id) as match_count
      FROM fixtures f
      JOIN odds o ON f.id = o.fixture_id
      GROUP BY match_date::date 
      ORDER BY match_date::date 
      LIMIT 10
    `);
    console.log('Matches WITH odds by date:');
    console.table(res.rows);
  } catch (err) {
    console.error('Error querying database:', err);
  } finally {
    await pool.end();
  }
}

checkFixtures();
