import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../config/database';
import jwt from 'jsonwebtoken';
import { ensureWithdrawalMethodsTable, ensureWithdrawalSchema } from '../db/ensureWithdrawalRequests';
import { ensureManualPresetSchema } from '../db/ensureManualPresetSchema';
import { allocateUniqueTicketCode } from '../utils/ticketCode';
import {
  getWithdrawalMinTotalDeposit,
  setWithdrawalMinTotalDeposit,
} from '../services/depositRule';
import {
  getSupportTelegramUsername,
  setSupportTelegramUsername,
} from '../services/supportTelegram';

const router = Router();

// Middleware to verify admin
const verifyAdmin = (req: Request, res: Response, next: any) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-tipico');
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Require Admin Role' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

// Add deposit method
router.post('/deposit-methods', verifyAdmin, async (req: Request, res: Response) => {
  const { name, logoUrl, minAmount, accountDetails, accountName } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO deposit_methods (name, logo_url, min_amount, account_details, account_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, logoUrl, minAmount, accountDetails, accountName]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding deposit method:', err);
    res.status(500).json({ message: 'Failed to add deposit method' });
  }
});

// Get all deposit methods
router.get('/deposit-methods', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM deposit_methods WHERE active = true ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch deposit methods' });
  }
});

// Update deposit method
router.put('/deposit-methods/:id', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, logoUrl, minAmount, accountDetails, accountName } = req.body;

  try {
    const result = await pool.query(
      `UPDATE deposit_methods 
       SET name = $1, logo_url = $2, min_amount = $3, account_details = $4, account_name = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name, logoUrl, minAmount, accountDetails, accountName, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Method not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update deposit method' });
  }
});

// Delete deposit method (Soft delete by setting active = false)
router.delete('/deposit-methods/:id', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'UPDATE deposit_methods SET active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Method not found' });
    }

    res.json({ message: 'Method deleted successfully', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete deposit method' });
  }
});

// --- Withdrawal Methods ---

// Add withdrawal method
router.post('/withdrawal-methods', verifyAdmin, async (req: Request, res: Response) => {
  const { name, type, logoUrl } = req.body;

  try {
    await ensureWithdrawalMethodsTable();

    // Check for duplicates
    const checkResult = await pool.query(
      'SELECT id FROM withdrawal_methods WHERE name = $1 AND active = true',
      [name]
    );

    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'This method already exists' });
    }

    const result = await pool.query(
      `INSERT INTO withdrawal_methods (name, type, logo_url)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, type, logoUrl]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding withdrawal method:', err);
    res.status(500).json({ message: 'Failed to add withdrawal method' });
  }
});

// Get all withdrawal methods
router.get('/withdrawal-methods', async (_req: Request, res: Response) => {
  try {
    await ensureWithdrawalMethodsTable();

    const result = await pool.query('SELECT * FROM withdrawal_methods WHERE active = true ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch withdrawal methods error:', err);
    res.status(500).json({ message: 'Failed to fetch withdrawal methods' });
  }
});

// Delete withdrawal method
router.delete('/withdrawal-methods/:id', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await ensureWithdrawalMethodsTable();
    await pool.query('UPDATE withdrawal_methods SET active = false, updated_at = NOW() WHERE id = $1', [id]);
    res.json({ message: 'Method deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete withdrawal method' });
  }
});

// Get count of pending deposit requests
router.get('/deposit-requests/count', verifyAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM deposit_requests WHERE status = \'pending\''
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Error fetching deposit count:', err);
    res.status(500).json({ message: 'Failed to fetch deposit count' });
  }
});

// Get all pending and approved deposit requests
router.get('/deposit-requests', verifyAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT dr.*, u.phone, dm.name as method_name 
       FROM deposit_requests dr
       JOIN users u ON dr.user_id = u.id
       JOIN deposit_methods dm ON dr.method_id = dm.id
       WHERE dr.status IN ('pending', 'approved')
       ORDER BY dr.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching deposit requests:', err);
    res.status(500).json({ message: 'Failed to fetch deposit requests' });
  }
});

// Approve deposit
router.post('/deposit-requests/:id/approve', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get request details
    const requestResult = await client.query(
      'SELECT * FROM deposit_requests WHERE id = $1 AND status = \'pending\'',
      [id]
    );

    if (requestResult.rows.length === 0) {
      throw new Error('Request not found or already processed');
    }

    const { user_id, amount } = requestResult.rows[0];

    // 2. Update status
    await client.query(
      'UPDATE deposit_requests SET status = \'approved\', updated_at = NOW() WHERE id = $1',
      [id]
    );

    // 3. Add balance to user wallet
    await client.query(
      'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
      [amount, user_id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Deposit approved and balance updated' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Error approving deposit:', err);
    res.status(500).json({ message: err.message || 'Failed to approve deposit' });
  } finally {
    client.release();
  }
});

// Reject/Delete deposit
router.delete('/deposit-requests/:id', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM deposit_requests WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Request not found' });
    }

    res.json({ message: 'Deposit request rejected and deleted' });
  } catch (err) {
    console.error('Error deleting deposit request:', err);
    res.status(500).json({ message: 'Failed to delete deposit request' });
  }
});

// --- Withdrawal requests (user balance already deducted when request was created) ---

router.get('/withdrawal-requests/count', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    await ensureWithdrawalSchema();
    const result = await pool.query(
      `SELECT COUNT(*)::int AS c FROM withdrawal_requests WHERE status = 'pending'`
    );
    res.json({ count: result.rows[0]?.c ?? 0 });
  } catch (err) {
    console.error('withdrawal-requests count:', err);
    res.status(500).json({ message: 'Failed to fetch withdrawal count' });
  }
});

router.get('/withdrawal-requests', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    await ensureWithdrawalSchema();
    const result = await pool.query(
      `SELECT wr.*, u.phone, wm.name AS method_name
       FROM withdrawal_requests wr
       JOIN users u ON wr.user_id = u.id
       LEFT JOIN withdrawal_methods wm ON wr.method_id = wm.id
       WHERE wr.status IN ('pending', 'approved')
       ORDER BY wr.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('withdrawal-requests list:', err);
    res.status(500).json({ message: 'Failed to fetch withdrawal requests' });
  }
});

router.post('/withdrawal-requests/:id/approve', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await ensureWithdrawalSchema();
    const result = await pool.query(
      `UPDATE withdrawal_requests
       SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Request not found or already processed' });
    }
    res.json({ message: 'Withdrawal marked as paid out' });
  } catch (err) {
    console.error('withdrawal approve:', err);
    res.status(500).json({ message: 'Failed to approve withdrawal' });
  }
});

router.delete('/withdrawal-requests/:id', verifyAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await ensureWithdrawalSchema();
    await client.query('BEGIN');
    const reqRow = await client.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [id]
    );
    if (reqRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Request not found or already processed' });
    }
    const { user_id, amount } = reqRow.rows[0];
    await client.query(`UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`, [amount, user_id]);
    await client.query(
      `UPDATE withdrawal_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Withdrawal rejected; balance refunded to user' });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* */
    }
    console.error('withdrawal reject:', err);
    res.status(500).json({ message: 'Failed to reject withdrawal' });
  } finally {
    client.release();
  }
});

/** Winning bet slips (whole ticket won) — admin Tickets button badge. */
router.get('/bet-tickets/won-count', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM bet_slips WHERE LOWER(status) = 'won'`);
    res.json({ count: result.rows[0]?.count ?? 0 });
  } catch (err) {
    console.error('Bet tickets won count error:', err);
    res.status(500).json({ message: 'Failed to fetch winning ticket count' });
  }
});

/**
 * Manual ticket builder: ~20 clubs per day from smaller / non-elite leagues worldwide
 * (excludes leagues marked `is_top` — avoids household names from Premier League, La Liga, etc.).
 * Also returns a list of those smaller leagues for the admin UI.
 */
router.get('/manual-ticket-clubs', verifyAdmin, async (req: Request, res: Response) => {
  try {
    await ensureManualPresetSchema();
    const dateStr = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);

    const clubQuery = `
      SELECT t.id, t.name, t.logo, l.name AS league_name, c.code AS country_code, c.name AS country_name
      FROM teams t
      INNER JOIN leagues l ON l.id = t.league_id
      LEFT JOIN countries c ON c.id = t.country_id
      WHERE t.logo IS NOT NULL AND length(trim(t.name)) > 0
        AND l.is_top IS NOT TRUE
      ORDER BY md5(concat_ws('|', $1::text, t.id::text))
      LIMIT 20`;

    let { rows } = await pool.query<{
      id: number;
      name: string;
      logo: string;
      league_name: string | null;
      country_code: string | null;
      country_name: string | null;
    }>(clubQuery, [dateStr]);

    if (rows.length === 0) {
      const anyFb = await pool.query<{
        id: number;
        name: string;
        logo: string;
        league_name: string | null;
        country_code: string | null;
        country_name: string | null;
      }>(
        `SELECT t.id, t.name, t.logo, l.name AS league_name, c.code AS country_code, c.name AS country_name
         FROM teams t
         INNER JOIN leagues l ON l.id = t.league_id
         LEFT JOIN countries c ON c.id = t.country_id
         WHERE t.logo IS NOT NULL AND length(trim(t.name)) > 0
         ORDER BY md5(concat_ws('|', $1::text, t.id::text))
         LIMIT 20`,
        [dateStr]
      );
      rows = anyFb.rows;
    }

    const leaguesRes = await pool.query<{
      id: number;
      league_name: string | null;
      country_code: string | null;
      country_name: string | null;
    }>(
      `SELECT l.id, l.name AS league_name, c.code AS country_code, c.name AS country_name
       FROM leagues l
       LEFT JOIN countries c ON c.id = l.country_id
       WHERE l.is_top IS NOT TRUE
       ORDER BY COALESCE(c.name, ''), COALESCE(l.name, '')
       LIMIT 400`
    );

    res.json({
      date: dateStr,
      clubs: rows,
      small_leagues: leaguesRes.rows,
    });
  } catch (err) {
    console.error('manual-ticket-clubs:', err);
    res.status(500).json({ message: 'Failed to load clubs' });
  }
});

type ManualMatchInput = {
  home_team_id: number;
  away_team_id: number;
  selection: string;
  odd: number;
  market_name?: string;
  manual_kickoff_at: string;
  manual_end_at: string;
};

/** Preset ticket: exactly 3 manual legs, ticket code only (no user, no stake). Users copy code into slip. */
router.post('/manual-tickets', verifyAdmin, async (req: Request, res: Response) => {
  const matches = req.body?.matches as ManualMatchInput[] | undefined;
  if (!Array.isArray(matches) || matches.length !== 3) {
    res.status(400).json({ message: 'Provide exactly 3 matches' });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureManualPresetSchema();
    await client.query('BEGIN');

    const loadTeam = async (id: number) => {
      const r = await client.query<{
        id: number;
        name: string;
        logo: string | null;
        league_name: string | null;
      }>(
        `SELECT t.id, t.name, t.logo, l.name AS league_name
         FROM teams t
         LEFT JOIN leagues l ON l.id = t.league_id
         WHERE t.id = $1`,
        [id]
      );
      return r.rows[0] || null;
    };

    let totalOdds = 1;
    const rowsToInsert: Array<{
      selection: string;
      odd: number;
      market_name: string;
      home_team: string;
      away_team: string;
      home_logo: string | null;
      away_logo: string | null;
      league_name: string;
      manual_kickoff_at: Date;
      manual_end_at: Date;
    }> = [];

    for (const m of matches) {
      const hid = Number(m.home_team_id);
      const aid = Number(m.away_team_id);
      if (!Number.isFinite(hid) || !Number.isFinite(aid) || hid === aid) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: 'Each match needs two different team ids' });
        return;
      }
      const odd = parseFloat(String(m.odd));
      if (!Number.isFinite(odd) || odd < 1.01) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: 'Invalid odd' });
        return;
      }
      const kick = new Date(m.manual_kickoff_at);
      const end = new Date(m.manual_end_at);
      if (Number.isNaN(kick.getTime()) || Number.isNaN(end.getTime()) || end <= kick) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: 'Invalid kickoff or end time' });
        return;
      }
      const home = await loadTeam(hid);
      const away = await loadTeam(aid);
      if (!home || !away) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: 'Unknown team id' });
        return;
      }
      const sel = String(m.selection || '').trim();
      if (!sel) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: 'Selection required on each leg' });
        return;
      }
      totalOdds *= odd;
      const leagueLabel = [home.league_name, away.league_name].filter(Boolean).join(' / ') || 'Football';
      rowsToInsert.push({
        selection: sel,
        odd,
        market_name: String(m.market_name || '1X2').trim() || '1X2',
        home_team: home.name,
        away_team: away.name,
        home_logo: home.logo,
        away_logo: away.logo,
        league_name: leagueLabel,
        manual_kickoff_at: kick,
        manual_end_at: end,
      });
    }

    const ticketCode = await allocateUniqueTicketCode(client);
    const slip = await client.query(
      `INSERT INTO bet_slips (user_id, total_odds, stake, possible_win, status, ticket_code, is_manual_preset)
       VALUES (NULL, $1, 0, 0, 'pending', $2, true)
       RETURNING id, ticket_code, total_odds, created_at`,
      [Math.round(totalOdds * 10000) / 10000, ticketCode]
    );

    const slipId = slip.rows[0].id as number;
    for (const row of rowsToInsert) {
      await client.query(
        `INSERT INTO bet_selections (
          bet_slip_id, fixture_id, market_id, selection, odd,
          home_team, away_team, home_logo, away_logo, league_name, market_name,
          manual_kickoff_at, manual_end_at, is_manual_fixture
        ) VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
        [
          slipId,
          row.selection,
          row.odd,
          row.home_team,
          row.away_team,
          row.home_logo,
          row.away_logo,
          row.league_name,
          row.market_name,
          row.manual_kickoff_at,
          row.manual_end_at,
        ]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(slip.rows[0]);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* */
    }
    console.error('manual-tickets create:', err);
    res.status(500).json({ message: 'Failed to create manual ticket' });
  } finally {
    client.release();
  }
});

router.get('/manual-tickets', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    await ensureManualPresetSchema();
    const { rows } = await pool.query(
      `SELECT bs.id, bs.ticket_code, bs.total_odds, bs.status, bs.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'selection', bsel.selection,
              'odd', bsel.odd,
              'result', bsel.result,
              'home_team', bsel.home_team,
              'away_team', bsel.away_team,
              'home_logo', bsel.home_logo,
              'away_logo', bsel.away_logo,
              'league_name', bsel.league_name,
              'market_name', bsel.market_name,
              'manual_kickoff_at', bsel.manual_kickoff_at,
              'manual_end_at', bsel.manual_end_at
            )
            ORDER BY bsel.id
          ) FILTER (WHERE bsel.id IS NOT NULL),
          '[]'::json
        ) AS selections
       FROM bet_slips bs
       LEFT JOIN bet_selections bsel ON bsel.bet_slip_id = bs.id
       WHERE COALESCE(bs.is_manual_preset, false) = true
       GROUP BY bs.id
       ORDER BY bs.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('manual-tickets list:', err);
    res.status(500).json({ message: 'Failed to list manual tickets' });
  }
});

/** All users’ bet slips with legs (admin ticket view). */
router.get('/bet-tickets', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT bs.*, u.phone AS user_phone,
        COALESCE(
          json_agg(
            json_build_object(
              'fixture_id', bsel.fixture_id,
              'selection', bsel.selection,
              'odd', bsel.odd,
              'result', bsel.result,
              'home_team', bsel.home_team,
              'away_team', bsel.away_team,
              'home_logo', bsel.home_logo,
              'away_logo', bsel.away_logo,
              'league_name', bsel.league_name,
              'market_name', bsel.market_name
            )
            ORDER BY bsel.id
          ) FILTER (WHERE bsel.id IS NOT NULL),
          '[]'::json
        ) AS selections
       FROM bet_slips bs
       INNER JOIN users u ON u.id = bs.user_id
       LEFT JOIN bet_selections bsel ON bs.id = bsel.bet_slip_id
       GROUP BY bs.id, u.phone
       ORDER BY bs.created_at DESC
       LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin bet tickets error:', err);
    res.status(500).json({ message: 'Failed to fetch bet tickets' });
  }
});

/** List all accounts (no password hash). */
router.get('/users', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.phone, u.role, u.created_at,
              COALESCE(w.balance, 0)::text AS balance,
              COALESCE(w.currency, 'ETB') AS currency
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ message: 'Failed to list users' });
  }
});

/** Create a normal user account (same as public signup; wallet created). */
router.post('/users', verifyAdmin, async (req: Request, res: Response) => {
  const { phone, password } = req.body as { phone?: string; password?: string };
  if (!phone || !password) {
    res.status(400).json({ message: 'Phone and password are required' });
    return;
  }
  if (String(password).length < 6) {
    res.status(400).json({ message: 'Password must be at least 6 characters' });
    return;
  }

  const client = await pool.connect();
  try {
    const dup = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (dup.rows.length > 0) {
      res.status(400).json({ message: 'Phone number already registered' });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(String(password), salt);

    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO users (phone, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, phone, role, created_at`,
      [phone, passwordHash]
    );
    const u = ins.rows[0];
    await client.query(`INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, 'ETB')`, [u.id]);
    await client.query('COMMIT');
    res.status(201).json({ ...u, balance: '0.00', currency: 'ETB' });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    console.error('Admin create user error:', err);
    res.status(500).json({ message: 'Failed to create user' });
  } finally {
    client.release();
  }
});

// Get / set minimum total approved deposits required before withdrawal
router.get('/deposit-rule', verifyAdmin, async (_req: Request, res: Response) => {
  try {
    const minTotalDeposit = await getWithdrawalMinTotalDeposit();
    res.json({ minTotalDeposit });
  } catch (err) {
    console.error('deposit-rule get error:', err);
    res.status(500).json({ message: 'Failed to fetch deposit rule' });
  }
});

router.put('/deposit-rule', verifyAdmin, async (req: Request, res: Response) => {
  const amount = Number(req.body?.minTotalDeposit);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Valid minTotalDeposit greater than 0 is required' });
  }
  try {
    const minTotalDeposit = await setWithdrawalMinTotalDeposit(amount);
    res.json({ minTotalDeposit });
  } catch (err) {
    console.error('deposit-rule put error:', err);
    res.status(500).json({ message: 'Failed to save deposit rule' });
  }
});

// Support team Telegram (public read for site FAB; admin write)
router.get('/support-telegram', async (_req: Request, res: Response) => {
  try {
    const username = await getSupportTelegramUsername();
    res.json({ username });
  } catch (err) {
    console.error('support-telegram get error:', err);
    res.status(500).json({ message: 'Failed to fetch support Telegram' });
  }
});

router.put('/support-telegram', verifyAdmin, async (req: Request, res: Response) => {
  const raw = typeof req.body?.username === 'string' ? req.body.username : '';
  if (!raw.trim()) {
    return res.status(400).json({ message: 'Telegram username is required' });
  }
  try {
    const username = await setSupportTelegramUsername(raw);
    res.json({ username });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save';
    if (message === 'Invalid Telegram username') {
      return res.status(400).json({ message: 'Enter a valid Telegram username (5–32 letters, numbers, or _)' });
    }
    console.error('support-telegram put error:', err);
    res.status(500).json({ message: 'Failed to save support Telegram' });
  }
});

export default router;
