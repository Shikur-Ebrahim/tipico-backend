import { Router } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/database';
import { hashAuthPassword, verifyAuthPassword } from '../lib/authPassword';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-tipico';

const LOGIN_SELECT = `
  SELECT u.id, u.phone, u.role, u.created_at, u.password_hash,
         COALESCE(w.balance, 0) AS balance
  FROM users u
  LEFT JOIN wallets w ON w.user_id = u.id
  WHERE u.phone = $1
  LIMIT 1
`;

router.post('/signup', async (req, res) => {
  const { phone, password } = req.body ?? {};

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required' });
  }

  const client = await pool.connect();
  try {
    const passwordHash = await hashAuthPassword(password);
    await client.query('BEGIN');

    const newUser = await client.query(
      `INSERT INTO users (phone, password_hash)
       VALUES ($1, $2)
       RETURNING id, phone, role, created_at`,
      [phone, passwordHash]
    );

    const user = newUser.rows[0];
    await client.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2)',
      [user.id, 'ETB']
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { userId: user.id, phone: user.phone, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { ...user, balance: '0.00' },
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    const pgCode =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: string }).code)
        : '';
    if (pgCode === '23505') {
      return res.status(400).json({ error: 'Phone number already registered' });
    }
    console.error('Error in /signup:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body ?? {};

    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required' });
    }

    const result = await pool.query(LOGIN_SELECT, [phone]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await verifyAuthPassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        created_at: user.created_at,
        balance: user.balance,
      },
    });
  } catch (error) {
    console.error('Error in /login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
