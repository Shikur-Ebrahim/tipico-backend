import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function getSafeDatabaseName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid database name: ${name}`);
  }
  return name;
}

async function setupDatabase() {
  const dbName = getSafeDatabaseName(process.env.DB_NAME || 'betting_db');
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || 'postgres';

  const adminClient = new Client({
    host,
    port,
    user,
    password,
    database: 'postgres',
  });

  await adminClient.connect();

  const existingDb = await adminClient.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName]
  );

  if (existingDb.rowCount === 0) {
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Database created: ${dbName}`);
  } else {
    console.log(`Database already exists: ${dbName}`);
  }

  await adminClient.end();

  const appClient = new Client({
    host,
    port,
    user,
    password,
    database: dbName,
  });

  await appClient.connect();

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  await appClient.query(schema);

  console.log(`Schema created successfully in database: ${dbName}`);
  await appClient.end();
}

setupDatabase().catch((err) => {
  console.error('Database setup failed:', err);
  process.exit(1);
});
