import { Router, Request, Response } from 'express';
import {
  getSyncStatus,
  runBootstrapSync,
  runLiveSync,
  runOddsSync,
  ODDS_SYNC_BATCH,
} from '../services/syncService';

const router = Router();

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getSyncStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sync status' });
  }
});

router.post('/bootstrap', async (_req: Request, res: Response) => {
  try {
    const result = await runBootstrapSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Bootstrap sync failed' });
  }
});

router.post('/live', async (_req: Request, res: Response) => {
  try {
    const result = await runLiveSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Live sync failed' });
  }
});

router.post('/odds', async (req: Request, res: Response) => {
  const limit =
    typeof req.body?.limit === 'number' && req.body.limit > 0 ? req.body.limit : ODDS_SYNC_BATCH;

  try {
    const result = await runOddsSync(limit);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Odds sync failed' });
  }
});

export default router;
