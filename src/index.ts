import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from './config/database';
import { startSyncJobs } from './services/syncService';
import leaguesRouter from './routes/leagues';
import fixturesRouter from './routes/fixtures';
import teamsRouter from './routes/teams';
import oddsRouter from './routes/odds';
import liveRouter from './routes/live';
import bettingRouter from './routes/betting';
import syncRouter from './routes/sync';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import userRouter from './routes/user';
import chatRouter from './routes/chat';

import { ensureBetSlipSchema } from './db/ensureBetSlipSchema';
import { ensureWithdrawalMethodsTable } from './db/ensureWithdrawalRequests';
import { ensureAppSettings } from './db/ensureAppSettings';
import { ensureAuthSchema } from './db/ensureAuthSchema';
import { ensureDepositSchema } from './db/ensureDepositSchema';
import { ensurePromotionCodesSchema } from './db/ensurePromotionCodesSchema';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
/** Inbound request limiting was removed: a global 75k/day counter blocked login and all routes.
 *  API-Football daily quota (75,000) is enforced only on outbound calls in `services/apiQuota.ts`. */

app.get('/api/health', async (_req, res) => {
  const timestamp = new Date().toISOString();
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      const { rows } = await client.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM fixtures'
      );
      res.json({
        status: 'ok',
        db: true,
        fixture_count: rows[0]?.n ?? 0,
        timestamp,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(200).json({
      status: 'degraded',
      db: false,
      fixture_count: null,
      message: err instanceof Error ? err.message : 'database unreachable',
      timestamp,
    });
  }
});

app.use('/api/leagues', leaguesRouter);
app.use('/api/fixtures', fixturesRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/odds', oddsRouter);
app.use('/api/live', liveRouter);
app.use('/api/betting', bettingRouter);
app.use('/api/sync', syncRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/user', userRouter);
app.use('/api/chat', chatRouter);

async function startServer() {
  try {
    await ensureBetSlipSchema();
    await ensureWithdrawalMethodsTable();
    await ensureAppSettings();
    await ensureAuthSchema();
    await ensureDepositSchema();
    await ensurePromotionCodesSchema();
    void pool.query('SELECT 1').catch(() => undefined);
    console.log('[DB] schema ready');
  } catch (e) {
    console.error('[DB] startup schema ensure failed:', e);
  }

  app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
    startSyncJobs();
  });
}

void startServer();
