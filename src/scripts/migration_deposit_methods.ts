import pool from '../config/database';

async function runMigration() {
  console.log('Connecting to database...');
  try {
    const client = await pool.connect();
    try {
      console.log('Connected. Starting migration for deposit_methods...');

      await client.query(`
        CREATE TABLE IF NOT EXISTS deposit_methods (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          logo_url TEXT,
          min_amount DECIMAL(10,2) DEFAULT 0,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('Created deposit_methods table.');

      console.log('Migration completed successfully.');
    } catch (error) {
      console.error('Migration failed:', error);
    } finally {
      client.release();
      console.log('Database connection released.');
    }
  } catch (error) {
    console.error('Could not connect to database:', error);
  } finally {
    process.exit();
  }
}

runMigration();
