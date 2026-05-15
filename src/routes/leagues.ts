import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, c.name as country_name, c.flag_url
       FROM leagues l
       LEFT JOIN countries c ON l.country_id = c.id
       ORDER BY l.is_top DESC, l.top_rank ASC, l.name ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leagues' });
  }
});

router.get('/top', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, c.name as country_name, c.flag_url
       FROM leagues l
       LEFT JOIN countries c ON l.country_id = c.id
       WHERE l.is_top = true
       ORDER BY l.top_rank ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top leagues' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, c.name as country_name, c.flag_url
       FROM leagues l
       LEFT JOIN countries c ON l.country_id = c.id
       WHERE l.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'League not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch league' });
  }
});

export default router;
