import pool from '../config/database';
import bcrypt from 'bcryptjs';

async function runMigration() {
  console.log('Connecting to database...');
  try {
    const client = await pool.connect();
    try {
      console.log('Connected. Starting migration...');

      // 1. Add role column to users table if it doesn't exist
      console.log('Adding role column...');
      await client.query(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';
      `);
      console.log('Added role column to users table.');

      // 2. Create sample admin account
      const phone = '+251900000000';
      const password = 'admin123';
      
      console.log(`Checking if user ${phone} exists...`);
      const existingUser = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
      
      if (existingUser.rows.length === 0) {
        console.log('Creating new admin user...');
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        
        const result = await client.query(
          'INSERT INTO users (phone, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [phone, passwordHash, 'admin']
        );
        const userId = result.rows[0].id;
        
        console.log('Creating wallet for admin...');
        await client.query(
          'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2)',
          [userId, 'ETB']
        );
        
        console.log(`Sample admin user created: ${phone} / ${password}`);
      } else {
        console.log('Updating existing user to admin...');
        await client.query(
          'UPDATE users SET role = $1 WHERE phone = $2',
          ['admin', phone]
        );
        console.log(`Updated existing user ${phone} to admin.`);
      }

      console.log('Migration completed successfully.');
    } catch (error) {
      console.error('Migration failed:', error);
    } finally {
      client.release();
      console.log('Database connection released.');
    }
  } catch (error) {
    console.error('Could not connect to database:', error);
  } finally {
    process.exit();
  }
}

runMigration();
