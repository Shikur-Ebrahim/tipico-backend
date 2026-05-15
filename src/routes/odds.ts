import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

router.get('/fixture/:fixtureId', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (bm.id, o.selection) 
        o.*, b.name as bookmaker_name, b.logo as bookmaker_logo,
        bm.name as market_name, bm.market_key
       FROM odds o
       JOIN bookmakers b ON o.bookmaker_id = b.id
       JOIN bet_markets bm ON o.market_id = bm.id
       WHERE o.fixture_id = $1
       ORDER BY bm.id, o.selection, o.last_update DESC NULLS LAST,
         CASE WHEN b.api_bookmaker_id = 8 THEN 0 ELSE 1 END, b.id`,
      [req.params.fixtureId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch odds' });
  }
});

router.get('/live/:fixtureId', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT lo.*, bm.name as market_name
       FROM live_odds lo
       JOIN bet_markets bm ON lo.market_id = bm.id
       WHERE lo.fixture_id = $1
       ORDER BY lo.updated_at DESC`,
      [req.params.fixtureId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch live odds' });
  }
});

router.get('/bookmakers', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookmakers ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookmakers' });
  }
});

router.get('/markets', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bet_markets ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

export default router;
