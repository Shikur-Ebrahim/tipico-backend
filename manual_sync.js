const { runOddsSync } = require('./src/services/syncService');

async function manualSync() {
  console.log('Starting manual odds sync for all upcoming matches...');
  // Syncing a large number to cover the whole week
  const result = await runOddsSync(1000);
  console.log('Sync completed:', result);
  process.exit(0);
}

manualSync().catch(err => {
  console.error('Manual sync failed:', err);
  process.exit(1);
});
