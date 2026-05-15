import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const { league_id } = req.query;
    let query = `SELECT t.*, l.name as league_name, c.name as country_name
                 FROM teams t
                 LEFT JOIN leagues l ON t.league_id = l.id
                 LEFT JOIN countries c ON t.country_id = c.id
                 WHERE 1=1`;
    const params: number[] = [];

    if (league_id) {
      query += ` AND t.league_id = $1`;
      params.push(parseInt(league_id as string));
    }

    query += ` ORDER BY t.name ASC`;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, l.name as league_name, c.name as country_name
       FROM teams t
       LEFT JOIN leagues l ON t.league_id = l.id
       LEFT JOIN countries c ON t.country_id = c.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

router.get('/:id/statistics', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT ts.*, s.year as season_year
       FROM team_statistics ts
       JOIN seasons s ON ts.season_id = s.id
       WHERE ts.team_id = $1
       ORDER BY s.year DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team statistics' });
  }
});

router.get('/:id/players', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM players WHERE team_id = $1 ORDER BY position, name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

export default router;
