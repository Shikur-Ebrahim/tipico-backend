import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

router.get('/matches', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT lm.*, f.match_date,
        ht.name as home_team_name, ht.logo as home_team_logo,
        at.name as away_team_name, at.logo as away_team_logo,
        l.name as league_name, l.logo as league_logo, l.api_league_id,
        c.name as country_name, c.flag_url
       FROM live_matches lm
       JOIN fixtures f ON lm.fixture_id = f.id
       JOIN teams ht ON f.home_team_id = ht.id
       JOIN teams at ON f.away_team_id = at.id
       JOIN leagues l ON f.league_id = l.id
       LEFT JOIN countries c ON l.country_id = c.id
       WHERE lm.is_active = true
       ORDER BY f.match_date ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch live matches' });
  }
});

router.get('/matches/:fixtureId/events', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM live_events WHERE fixture_id = $1 ORDER BY minute ASC`,
      [req.params.fixtureId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch live events' });
  }
});

router.get('/matches/:fixtureId/statistics', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM live_statistics WHERE fixture_id = $1`,
      [req.params.fixtureId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch live statistics' });
  }
});

export default router;
