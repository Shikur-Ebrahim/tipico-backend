const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:shikur3828@localhost:5432/betting_db' });

async function migrate() {
  try {
    console.log('Migrating odds columns...');
    await pool.query('ALTER TABLE odds ALTER COLUMN odd_value TYPE DECIMAL(10,2)');
    await pool.query('ALTER TABLE odds_history ALTER COLUMN old_value TYPE DECIMAL(10,2)');
    await pool.query('ALTER TABLE odds_history ALTER COLUMN new_value TYPE DECIMAL(10,2)');
    await pool.query('ALTER TABLE live_odds ALTER COLUMN odd_value TYPE DECIMAL(10,2)');
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

migrate();
