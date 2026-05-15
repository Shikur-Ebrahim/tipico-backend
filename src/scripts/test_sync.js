const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/tipico'
});

// Mocking required functions for the test
const { refreshFixtureAndOddsFromApi } = require('../services/apiFootball');

async function test() {
  const fixtureId = 791;
  console.log(`Starting JIT sync for fixture ID: ${fixtureId}`);
  try {
    const { rows } = await pool.query('SELECT api_fixture_id, status FROM fixtures WHERE id = $1', [fixtureId]);
    if (rows.length === 0) {
      console.log('Fixture not found in DB!');
      return;
    }
    console.log('Found fixture in DB:', rows[0]);
    
    await refreshFixtureAndOddsFromApi(fixtureId, { force: true });
    console.log('Sync completed.');
    
    const events = await pool.query('SELECT count(*) FROM fixture_events WHERE fixture_id = $1', [fixtureId]);
    const stats = await pool.query('SELECT count(*) FROM fixture_statistics WHERE fixture_id = $1', [fixtureId]);
    const lineups = await pool.query('SELECT count(*) FROM lineups WHERE fixture_id = $1', [fixtureId]);
    
    console.log(`Results for fixture ${fixtureId}:`);
    console.log(`- Events: ${events.rows[0].count}`);
    console.log(`- Stats: ${stats.rows[0].count}`);
    console.log(`- Lineups: ${lineups.rows[0].count}`);
    
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await pool.end();
  }
}

test();
