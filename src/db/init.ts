import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import pool from '../config/database';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function initDB() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    await client.query(schema);
    console.log('Database schema created successfully.');
  } catch (err) {
    console.error('Failed to initialize database:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

initDB();
