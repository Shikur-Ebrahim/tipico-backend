import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../config/database';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-tipico';

router.post('/signup', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required' });
    }

    // Check if user already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert user
    const newUser = await pool.query(
      'INSERT INTO users (phone, password_hash) VALUES ($1, $2) RETURNING id, phone, role, created_at',
      [phone, passwordHash]
    );

    const user = newUser.rows[0];

    // Create wallet with initial balance of 0.00
    await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2)',
      [user.id, 'ETB']
    );

    user.balance = '0.00';

    // Generate token
    const token = jwt.sign({ userId: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user
    });
  } catch (error) {
    console.error('Error in /signup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required' });
    }

    // Find user and their wallet balance
    const result = await pool.query(`
      SELECT u.*, COALESCE(w.balance, 0) as balance 
      FROM users u 
      LEFT JOIN wallets w ON u.id = w.user_id 
      WHERE u.phone = $1
    `, [phone]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign({ userId: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        created_at: user.created_at,
        balance: user.balance
      }
    });
  } catch (error) {
    console.error('Error in /login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
