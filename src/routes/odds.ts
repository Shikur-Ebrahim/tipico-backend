import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { sqlMarketIsDisplayable } from '../utils/displayableOdds';

const router = Router();

const MAX_BULK_FIXTURE_IDS = 120;

const ODDS_SELECT = `SELECT DISTINCT ON (o.fixture_id, bm.id, o.selection) 
        o.*, b.name as bookmaker_name, b.logo as bookmaker_logo,
        bm.name as market_name, bm.market_key`;

const ODDS_FROM = `FROM odds o
       JOIN bookmakers b ON o.bookmaker_id = b.id
       JOIN bet_markets bm ON o.market_id = bm.id`;

/** Read odds from DB only — API-Football is updated by backend sync jobs, not on this route. */
router.get('/bulk', async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.ids || req.query.fixture_ids || '').trim();
    if (!raw) {
      res.json({});
      return;
    }
    const ids = raw
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, MAX_BULK_FIXTURE_IDS);
    if (ids.length === 0) {
      res.json({});
      return;
    }

    const { rows } = await pool.query(
      `${ODDS_SELECT}
       ${ODDS_FROM}
       WHERE o.fixture_id = ANY($1::int[])
         AND o.odd_value IS NOT NULL
         AND o.odd_value > 0
         AND ${sqlMarketIsDisplayable('bm')}
       ORDER BY o.fixture_id, bm.id, o.selection, o.last_update DESC NULLS LAST,
         CASE WHEN b.api_bookmaker_id = 8 THEN 0 ELSE 1 END, b.id`,
      [ids]
    );
    const byFixture: Record<string, typeof rows> = {};
    for (const row of rows) {
      const fid = String(row.fixture_id);
      if (!byFixture[fid]) byFixture[fid] = [];
      byFixture[fid].push(row);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(byFixture);
  } catch (err) {
    console.error('Bulk odds error:', err);
    res.status(200).json({});
  }
});

router.get('/fixture/:fixtureId', async (req: Request, res: Response) => {
  try {
    const fixtureId = parseInt(req.params.fixtureId as string, 10);
    if (Number.isNaN(fixtureId)) {
      res.status(400).json({ error: 'Invalid fixture id' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (bm.id, o.selection) 
        o.*, b.name as bookmaker_name, b.logo as bookmaker_logo,
        bm.name as market_name, bm.market_key
       ${ODDS_FROM}
       WHERE o.fixture_id = $1
       ORDER BY bm.id, o.selection, o.last_update DESC NULLS LAST,
         CASE WHEN b.api_bookmaker_id = 8 THEN 0 ELSE 1 END, b.id`,
      [fixtureId]
    );
    res.setHeader('Cache-Control', 'no-store');
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
