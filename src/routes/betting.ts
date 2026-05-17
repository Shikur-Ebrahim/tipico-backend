import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/database';
import { isFixturePreMatchOnly } from '../utils/matchStatus';
import { allocateUniqueTicketCode } from '../utils/ticketCode';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-tipico';

function getUserIdFromBearer(req: Request): number | null {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
    return typeof decoded.userId === 'number' ? decoded.userId : null;
  } catch {
    return null;
  }
}

function normalizeTicketCodeParam(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^#/i, '')
    .replace(/^code:\s*/i, '')
    .trim()
    .toUpperCase();
}

router.get('/wallet', async (req: Request, res: Response) => {
  const userId = getUserIdFromBearer(req);
  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  try {
    const { rows } = await pool.query(
      'SELECT balance, currency FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Wallet not found' });
      return;
    }
    res.json({
      balance: parseFloat(rows[0].balance),
      currency: rows[0].currency || 'ETB',
    });
  } catch (err) {
    console.error('Wallet fetch error:', err);
    res.status(500).json({ message: 'Failed to load wallet' });
  }
});

/** Public: look up a ticket by code to copy its picks (same code format as bet history). */
router.get('/ticket-code/:code', async (req: Request, res: Response) => {
  const rawParam = req.params.code;
  const codeParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  const code = normalizeTicketCodeParam(codeParam || '');
  if (!code) {
    res.status(400).json({ message: 'Enter a ticket code' });
    return;
  }

  try {
    const { rows } = await pool.query<{
      fixture_id: number | null;
      selection: string;
      odd: string | number;
      home_team: string;
      away_team: string;
      home_logo: string | null;
      away_logo: string | null;
      league_name: string | null;
      market_name: string | null;
      fixture_status: string | null;
      manual_kickoff_at: Date | string | null;
      manual_end_at: Date | string | null;
      is_manual_fixture: boolean | null;
    }>(
      `SELECT
         bsel.fixture_id,
         bsel.selection,
         bsel.odd,
         bsel.home_team,
         bsel.away_team,
         bsel.home_logo,
         bsel.away_logo,
         bsel.league_name,
         bsel.market_name,
         f.status AS fixture_status,
         bsel.manual_kickoff_at,
         bsel.manual_end_at,
         bsel.is_manual_fixture
       FROM bet_slips bs
       INNER JOIN bet_selections bsel ON bsel.bet_slip_id = bs.id
       LEFT JOIN fixtures f ON f.id = bsel.fixture_id
       WHERE bs.ticket_code IS NOT NULL
         AND UPPER(TRIM(bs.ticket_code)) = $1
       ORDER BY bsel.id ASC`,
      [code]
    );

    if (rows.length === 0) {
      res.status(404).json({ message: 'No ticket found for this code' });
      return;
    }

    const now = Date.now();
    const selections = rows.map((r) => {
      const fid = r.fixture_id;
      const st = r.fixture_status;
      const isManual = r.is_manual_fixture === true || (fid == null && r.manual_kickoff_at != null);
      let blocked = false;
      if (isManual) {
        const kick = r.manual_kickoff_at ? new Date(r.manual_kickoff_at).getTime() : NaN;
        blocked = !Number.isFinite(kick) || now >= kick;
      } else {
        const missing = fid == null;
        const prematch = !missing && isFixturePreMatchOnly(st);
        blocked = missing || !prematch;
      }
      return {
        fixture_id: fid,
        selection: r.selection,
        odd: parseFloat(String(r.odd)) || 1,
        home_team: r.home_team,
        away_team: r.away_team,
        home_logo: r.home_logo ?? '',
        away_logo: r.away_logo ?? '',
        league_name: r.league_name ?? '',
        market_name: r.market_name ?? 'General',
        fixture_status: st ?? (isManual ? 'MANUAL' : ''),
        manual_kickoff_at: r.manual_kickoff_at ? new Date(r.manual_kickoff_at).toISOString() : null,
        manual_end_at: r.manual_end_at ? new Date(r.manual_end_at).toISOString() : null,
        is_manual: isManual,
        blocked,
      };
    });

    const anyBlocked = selections.some((s) => s.blocked);
    const allManualWithEnd =
      selections.length > 0 &&
      selections.every((s) => s.is_manual && s.manual_end_at != null && String(s.manual_end_at).length > 0);
    const allManualLegsFinished =
      allManualWithEnd &&
      selections.every((s) => {
        const t = new Date(s.manual_end_at as string).getTime();
        return Number.isFinite(t) && now >= t;
      });

    let message: string | null = null;
    if (allManualLegsFinished) {
      message = 'This ticket code has expired. All matches have finished.';
    } else if (anyBlocked) {
      message = 'The game has already started. You cannot place this bet.';
    }

    res.json({
      ticket_code: code,
      selections,
      can_place: !anyBlocked && !allManualLegsFinished,
      message,
    });
  } catch (err) {
    console.error('Ticket code lookup error:', err);
    res.status(500).json({ message: 'Failed to look up ticket' });
  }
});

/** Public: view a placed ticket (stake, status, leg results) — no login. */
router.get('/ticket-check/:code', async (req: Request, res: Response) => {
  const rawParam = req.params.code;
  const codeParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  const code = normalizeTicketCodeParam(codeParam || '');
  if (!code) {
    res.status(400).json({ message: 'Enter a ticket code' });
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT bs.id,
        bs.ticket_code,
        bs.stake,
        bs.total_odds,
        bs.possible_win,
        bs.status,
        bs.created_at,
        COALESCE(json_agg(
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
            'market_name', bsel.market_name,
            'kickoff_at', COALESCE(bsel.manual_kickoff_at, f.match_date)
          )
          ORDER BY bsel.id
        ) FILTER (WHERE bsel.id IS NOT NULL), '[]') AS selections
       FROM bet_slips bs
       LEFT JOIN bet_selections bsel ON bs.id = bsel.bet_slip_id
       LEFT JOIN fixtures f ON f.id = bsel.fixture_id
       WHERE bs.ticket_code IS NOT NULL
         AND UPPER(TRIM(bs.ticket_code)) = $1
       GROUP BY bs.id`,
      [code]
    );

    if (rows.length === 0) {
      res.status(404).json({ message: 'No ticket found for this code' });
      return;
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Ticket check error:', err);
    res.status(500).json({ message: 'Failed to look up ticket' });
  }
});

// Place bet
router.post('/bet', async (req: Request, res: Response) => {
  const { user_id, selections, stake, enforce_prematch_from_ticket: enforcePrematchRaw } = req.body;
  const tokenUserId = getUserIdFromBearer(req);

  if (tokenUserId === null) {
    res.status(401).json({ message: 'Login required to place a bet' });
    return;
  }

  if (tokenUserId !== Number(user_id)) {
    res.status(403).json({ message: 'Cannot place bet for another user' });
    return;
  }

  if (!user_id || !Array.isArray(selections) || selections.length === 0) {
    res.status(400).json({ message: 'Invalid bet payload' });
    return;
  }

  const stakeNum = parseFloat(String(stake));
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) {
    res.status(400).json({ message: 'Invalid stake' });
    return;
  }

  const enforcePrematchFromTicket = enforcePrematchRaw === true || enforcePrematchRaw === 'true';

  if (enforcePrematchFromTicket) {
    for (const sel of selections as Array<{
      fixture_id?: number | null;
      manual_kickoff_at?: string;
      manual_end_at?: string;
    }>) {
      const fid = sel.fixture_id;
      if (fid != null && fid !== undefined) {
        const fixtureRes = await pool.query<{ status: string | null }>(
          `SELECT status FROM fixtures WHERE id = $1 OR api_fixture_id = $1 LIMIT 1`,
          [fid]
        );
        if (fixtureRes.rows.length === 0) {
          res.status(400).json({ message: 'One or more matches could not be found.' });
          return;
        }
        if (!isFixturePreMatchOnly(fixtureRes.rows[0].status)) {
          res.status(400).json({ message: 'The game has already started. You cannot place this bet.' });
          return;
        }
      } else {
        const mk = sel.manual_kickoff_at;
        if (!mk || Number.isNaN(new Date(mk).getTime())) {
          res.status(400).json({ message: 'Invalid selection: missing fixture or manual kickoff time' });
          return;
        }
        if (Date.now() >= new Date(mk).getTime()) {
          res.status(400).json({ message: 'The game has already started. You cannot place this bet.' });
          return;
        }
        const mend = sel.manual_end_at;
        if (mend && !Number.isNaN(new Date(mend).getTime()) && Date.now() >= new Date(mend).getTime()) {
          res.status(400).json({ message: 'This ticket code has expired. All matches have finished.' });
          return;
        }
      }
    }
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Check user balance
    const walletRes = await client.query('SELECT balance FROM wallets WHERE user_id = $1', [user_id]);
    if (walletRes.rows.length === 0) throw new Error('Wallet not found');

    const balance = parseFloat(walletRes.rows[0].balance);
    if (balance < stakeNum) {
      await client.query('ROLLBACK');
      res.status(400).json({
        message: `Insufficient balance. You have ${balance.toFixed(2)} but stake is ${stakeNum.toFixed(2)}.`,
      });
      return;
    }

    // 2. Deduct stake
    await client.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [stakeNum, user_id]);

    // 3. Create bet slip with ticket code (T + DD + LL + DD, seven chars)
    const ticketCode = await allocateUniqueTicketCode(client);
    const totalOdds = selections.reduce(
      (acc: number, s: { odd: number }) => acc * (parseFloat(String(s.odd)) || 1),
      1
    );
    const possibleWin = stakeNum * totalOdds;

    const slip = await client.query(
      `INSERT INTO bet_slips (user_id, total_odds, stake, possible_win, status, ticket_code)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [user_id, totalOdds, stakeNum, possibleWin, ticketCode]
    );
    const slipId = slip.rows[0].id;

    // 4. Create selections — real fixtures and/or admin manual legs (fixture_id null + manual times)
    for (const sel of selections as Array<{
      fixture_id?: number | null;
      market_id?: number | null;
      selection?: string;
      odd?: number;
      home_team?: string;
      away_team?: string;
      home_logo?: string | null;
      away_logo?: string | null;
      league_name?: string;
      market_name?: string;
      manual_kickoff_at?: string | null;
      manual_end_at?: string | null;
    }>) {
      const fid = sel.fixture_id;
      let fixture_id: number | null = null;
      if (fid != null && fid !== undefined) {
        const fixtureRes = await client.query(
          `SELECT id FROM fixtures WHERE id = $1 OR api_fixture_id = $1 LIMIT 1`,
          [fid]
        );
        fixture_id = fixtureRes.rows.length > 0 ? fixtureRes.rows[0].id : null;
      }
      const isManual = fixture_id == null && !!sel.manual_kickoff_at;

      await client.query(
        `INSERT INTO bet_selections (
          bet_slip_id, fixture_id, market_id, selection, odd, 
          home_team, away_team, home_logo, away_logo, league_name, market_name,
          manual_kickoff_at, manual_end_at, is_manual_fixture
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          slipId,
          fixture_id,
          sel.market_id || null,
          sel.selection || 'N/A',
          sel.odd || 1.0,
          sel.home_team || 'Unknown',
          sel.away_team || 'Unknown',
          sel.home_logo || null,
          sel.away_logo || null,
          sel.league_name || 'General',
          sel.market_name || 'General',
          sel.manual_kickoff_at || null,
          sel.manual_end_at || null,
          isManual,
        ]
      );
    }

    const walletAfter = await client.query('SELECT balance, currency FROM wallets WHERE user_id = $1', [user_id]);

    await client.query('COMMIT');
    res.status(201).json({
      ...slip.rows[0],
      wallet_balance: parseFloat(walletAfter.rows[0].balance),
      currency: walletAfter.rows[0].currency || 'ETB',
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Bet placement error:', err);
    res.status(500).json({ message: err.message || 'Failed to place bet. Please check your selections and try again.' });
  } finally {
    client.release();
  }
});

// Get user bet history
router.get('/history/:userId', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT bs.*,
        COALESCE(json_agg(
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
            'market_name', bsel.market_name,
            'kickoff_at', COALESCE(bsel.manual_kickoff_at, f.match_date)
          )
          ORDER BY bsel.id
        ) FILTER (WHERE bsel.id IS NOT NULL), '[]') as selections
       FROM bet_slips bs
       LEFT JOIN bet_selections bsel ON bs.id = bsel.bet_slip_id
       LEFT JOIN fixtures f ON f.id = bsel.fixture_id
       WHERE bs.user_id = $1
       GROUP BY bs.id
       ORDER BY bs.created_at DESC`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Bet history error:', err);
    res.status(500).json({ error: 'Failed to fetch bet history' });
  }
});

// Cashout
router.post('/cashout', async (req: Request, res: Response) => {
  try {
    const { bet_slip_id, offer_amount } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO cashout_requests (bet_slip_id, offer_amount, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [bet_slip_id, offer_amount]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to request cashout' });
  }
});

export default router;
