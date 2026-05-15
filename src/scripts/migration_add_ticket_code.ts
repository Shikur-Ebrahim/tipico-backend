import pool from '../config/database';

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting migration: Adding ticket_code and match details...');
    
    // Add columns to bet_slips
    await client.query(`
      ALTER TABLE bet_slips 
      ADD COLUMN IF NOT EXISTS ticket_code VARCHAR(50);
    `);
    console.log('Added ticket_code to bet_slips');

    // Add columns to bet_selections
    await client.query(`
      ALTER TABLE bet_selections 
      ADD COLUMN IF NOT EXISTS home_team VARCHAR(150),
      ADD COLUMN IF NOT EXISTS away_team VARCHAR(150),
      ADD COLUMN IF NOT EXISTS home_logo TEXT,
      ADD COLUMN IF NOT EXISTS away_logo TEXT,
      ADD COLUMN IF NOT EXISTS league_name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS market_name VARCHAR(150);
    `);
    console.log('Added match details to bet_selections');

    console.log('Migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    client.release();
    process.exit();
  }
}

migrate();
