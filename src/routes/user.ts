import { Router, Request, Response } from 'express';
import pool from '../config/database';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { ensureWithdrawalSchema } from '../db/ensureWithdrawalRequests';
import { checkWithdrawalDepositEligibility } from '../services/depositRule';

const router = Router();

// Middleware to verify user
const verifyUser = (req: Request, res: Response, next: any) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-tipico');
    req.body.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

// Submit deposit request
router.post('/deposit-request', verifyUser, async (req: Request, res: Response) => {
  const { userId, methodId, amount, screenshotUrl } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO deposit_requests (user_id, method_id, amount, screenshot_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, methodId, amount, screenshotUrl]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error submitting deposit request:', err);
    res.status(500).json({ message: 'Failed to submit deposit request' });
  }
});

const DEPOSIT_METHODS_SELECT = `
  SELECT id, name, logo_url, min_amount, account_details, account_name
  FROM deposit_methods
  WHERE active = true
  ORDER BY name ASC
`;

/** One round-trip: pending status + active deposit methods (for fast deposit modal). */
router.get('/deposit-bootstrap', verifyUser, async (req: Request, res: Response) => {
  const { userId } = req.body;

  try {
    const [pendingRes, methodsRes] = await Promise.all([
      pool.query(
        `SELECT 1 FROM deposit_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
        [userId]
      ),
      pool.query(DEPOSIT_METHODS_SELECT),
    ]);

    res.json({
      hasPending: pendingRes.rows.length > 0,
      methods: methodsRes.rows,
    });
  } catch (err) {
    console.error('Error in deposit-bootstrap:', err);
    res.status(500).json({ message: 'Failed to load deposit data' });
  }
});

// Get pending deposit request for user
router.get('/pending-deposit', verifyUser, async (req: Request, res: Response) => {
  const { userId } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM deposit_requests WHERE user_id = $1 AND status = \'pending\' LIMIT 1',
      [userId]
    );

    res.json({ hasPending: result.rows.length > 0, request: result.rows[0] || null });
  } catch (err) {
    console.error('Error checking pending deposit:', err);
    res.status(500).json({ message: 'Failed to check pending deposit' });
  }
});

// Get deposit history for user
router.get('/deposit-history', verifyUser, async (req: Request, res: Response) => {
  const { userId } = req.body;

  try {
    const result = await pool.query(
      `SELECT dr.*, dm.name as method_name, dm.logo_url as method_logo
       FROM deposit_requests dr
       JOIN deposit_methods dm ON dr.method_id = dm.id
       WHERE dr.user_id = $1
       ORDER BY dr.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching deposit history:', err);
    res.status(500).json({ message: 'Failed to fetch deposit history' });
  }
});

// Change password
router.post('/change-password', verifyUser, async (req: Request, res: Response) => {
  const { userId, currentPassword, newPassword } = req.body;

  try {
    // 1. Get user
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ message: 'User not found' });

    const user = userResult.rows[0];

    // 2. Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) return res.status(400).json({ message: 'Incorrect current password' });

    // 3. Hash new password
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);

    // 4. Update password
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({ message: 'Failed to change password' });
  }
});

// Pending withdrawal (balance already held until admin approves or rejects)
router.get('/pending-withdrawal', verifyUser, async (req: Request, res: Response) => {
  const { userId } = req.body;
  try {
    await ensureWithdrawalSchema();
    const result = await pool.query(
      `SELECT wr.*, wm.name AS method_name
       FROM withdrawal_requests wr
       LEFT JOIN withdrawal_methods wm ON wr.method_id = wm.id
       WHERE wr.user_id = $1 AND wr.status = 'pending'
       ORDER BY wr.created_at DESC
       LIMIT 1`,
      [userId]
    );
    res.json({ hasPending: result.rows.length > 0, request: result.rows[0] || null });
  } catch (err) {
    console.error('pending-withdrawal error:', err);
    res.status(500).json({ message: 'Failed to check withdrawal status' });
  }
});

router.get('/withdrawal-history', verifyUser, async (req: Request, res: Response) => {
  const { userId } = req.body;
  try {
    await ensureWithdrawalSchema();
    const result = await pool.query(
      `SELECT wr.*, wm.name AS method_name, wm.type AS method_type
       FROM withdrawal_requests wr
       LEFT JOIN withdrawal_methods wm ON wr.method_id = wm.id
       WHERE wr.user_id = $1
       ORDER BY wr.created_at DESC
       LIMIT 100`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('withdrawal-history error:', err);
    res.status(500).json({ message: 'Failed to fetch withdrawal history' });
  }
});

// Check if user meets minimum total approved deposit for withdrawals
router.get('/withdrawal-eligibility', verifyUser, async (req: Request, res: Response) => {
  const userId = req.body.userId;
  try {
    const eligibility = await checkWithdrawalDepositEligibility(userId);
    res.json(eligibility);
  } catch (err) {
    console.error('withdrawal-eligibility error:', err);
    res.status(500).json({ message: 'Failed to check withdrawal eligibility' });
  }
});

// Submit withdrawal request — deducts balance immediately; admin marks payout complete or rejects (refund).
router.post('/withdrawal-request', verifyUser, async (req: Request, res: Response) => {
  const { userId, methodId, amount, accountName, accountDetails } = req.body;
  const amt = Number(amount);
  const client = await pool.connect();

  try {
    await ensureWithdrawalSchema();

    if (!methodId || !Number.isFinite(amt) || amt < 100) {
      return res.status(400).json({ message: 'Valid method and amount (min 100 ETB) are required' });
    }
    if (!accountName?.trim() || !accountDetails?.trim()) {
      return res.status(400).json({ message: 'Account name and details are required' });
    }

    const pendingCheck = await client.query(
      `SELECT id FROM withdrawal_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
      [userId]
    );
    if (pendingCheck.rows.length > 0) {
      return res.status(400).json({ message: 'You already have a withdrawal in processing. Wait for it to complete.' });
    }

    const { eligible, totalDeposits, minRequired } = await checkWithdrawalDepositEligibility(userId);
    if (!eligible) {
      return res.status(400).json({
        message: `To withdraw in Tipico betting, your total approved deposits must reach ${minRequired} ETB. You have deposited ${totalDeposits.toFixed(2)} ETB so far.`,
        code: 'DEPOSIT_RULE_NOT_MET',
        totalDeposits,
        minRequired,
      });
    }

    await client.query('BEGIN');

    const walletRes = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    if (walletRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Wallet not found' });
    }

    const currentBalance = parseFloat(walletRes.rows[0].balance);
    if (!Number.isFinite(currentBalance) || currentBalance < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    await client.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amt, userId]);

    const result = await client.query(
      `INSERT INTO withdrawal_requests (user_id, method_id, amount, account_name, account_details, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [userId, methodId, amt, String(accountName).trim(), String(accountDetails).trim()]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* no txn */
    }
    console.error('Withdrawal error:', err);
    res.status(500).json({ message: err.message || 'Failed to process withdrawal' });
  } finally {
    client.release();
  }
});

export default router;
