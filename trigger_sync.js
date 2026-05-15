const { runBootstrapSync } = require('./src/services/syncService');

async function triggerSync() {
  console.log('Starting full manual sync (Fixtures + Bulk Odds)...');
  try {
    const result = await runBootstrapSync();
    console.log('Sync completed successfully:', result);
  } catch (err) {
    console.error('Sync failed:', err);
  } finally {
    process.exit(0);
  }
}

triggerSync();
