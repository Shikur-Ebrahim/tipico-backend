/**
 * Bulk-copy football tables from SOURCE (e.g. local Postgres) to DEST (e.g. Render).
 * Much faster than re-syncing 500+ fixtures from API-Football.
 *
 * SAFETY: Refuses to run if DEST has bet_selections rows tied to real fixtures
 * (unless MIGRATE_FOOTBALL_ALLOW_BET_ORPHAN=1, which NULLs those fixture_id first — destructive).
 *
 * Usage (PowerShell, from backend/):
 *   $env:SOURCE_DATABASE_URL="postgresql://postgres:pw@localhost:5432/betting_db"
 *   $env:DATABASE_URL="postgresql://...@...render.com/...?sslmode=require"   # DEST (Render external from PC)
 *   $env:MIGRATE_FOOTBALL_CONFIRM="yes"
 *   node scripts/migrate-football-local-to-dest.js
 *
 * DEST is read from DATABASE_URL (same as .env). Set SOURCE_DATABASE_URL for local.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const DEST_URL = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
const CONFIRM = process.env.MIGRATE_FOOTBALL_CONFIRM === 'yes';

function sslFromUrl(u) {
  if (!u) return undefined;
  return u.includes('sslmode=require') || process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined;
}

const DELETE_ORDER = [
  'DELETE FROM odds_history',
  'DELETE FROM odds',
  'DELETE FROM live_odds',
  'DELETE FROM live_events',
  'DELETE FROM live_statistics',
  'DELETE FROM live_matches',
  'DELETE FROM fixture_events',
  'DELETE FROM fixture_statistics',
  'DELETE FROM lineups',
  'DELETE FROM player_statistics',
  'DELETE FROM injuries',
  'DELETE FROM standings',
  'DELETE FROM team_statistics',
  'DELETE FROM fixtures',
  'DELETE FROM players',
  'DELETE FROM seasons',
  'DELETE FROM teams',
  'DELETE FROM venues',
  'DELETE FROM leagues',
  'DELETE FROM countries',
  'DELETE FROM bookmakers',
  'DELETE FROM bet_markets',
];

const COPY_ORDER = [
  'countries',
  'bookmakers',
  'bet_markets',
  'leagues',
  'seasons',
  'venues',
  'teams',
  'fixtures',
  'odds',
];

async function tableColumns(pool, table) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function copyTable(src, dest, table) {
  const cols = await tableColumns(src, table);
  if (cols.length === 0) {
    console.warn(`[migrate] skip unknown table ${table}`);
    return 0;
  }
  const { rows } = await src.query(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${table}"`);
  if (rows.length === 0) return 0;

  const colList = cols.map((c) => `"${c}"`).join(',');
  const CHUNK = 300;
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map((_, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`)
      .join(',');
    const flat = chunk.flatMap((row) => cols.map((c) => row[c]));
    await dest.query(`INSERT INTO "${table}" (${colList}) VALUES ${placeholders}`, flat);
    n += chunk.length;
  }
  console.log(`[migrate] ${table}: ${n} rows`);
  return n;
}

async function resetSequences(dest) {
  for (const t of COPY_ORDER) {
    try {
      await dest.query(
        `SELECT setval(pg_get_serial_sequence($1::regclass, 'id'), (SELECT COALESCE(MAX(id), 1) FROM "${t}"), true)`,
        [`public.${t}`]
      );
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (!CONFIRM) {
    console.error('Set MIGRATE_FOOTBALL_CONFIRM=yes to run.');
    process.exit(1);
  }
  if (!SOURCE_URL) {
    console.error('Set SOURCE_DATABASE_URL to your local Postgres connection string.');
    process.exit(1);
  }
  if (!DEST_URL) {
    console.error('Set DATABASE_URL or DEST_DATABASE_URL for destination (Render).');
    process.exit(1);
  }

  const src = new Pool({ connectionString: SOURCE_URL, ssl: sslFromUrl(SOURCE_URL) });
  const dest = new Pool({ connectionString: DEST_URL, ssl: sslFromUrl(DEST_URL) });

  try {
    const { rows: betRows } = await dest.query(
      `SELECT COUNT(*)::int AS c FROM bet_selections WHERE fixture_id IS NOT NULL`
    );
    const betN = betRows[0].c;
    if (betN > 0 && process.env.MIGRATE_FOOTBALL_ALLOW_BET_ORPHAN !== '1') {
      console.error(
        `[migrate] Destination has ${betN} bet_selections with fixture_id. Refusing to wipe football data. ` +
          `Clear bets or set MIGRATE_FOOTBALL_ALLOW_BET_ORPHAN=1 to NULL those fixture_id first (breaks slip display for those legs).`
      );
      process.exit(1);
    }

    if (betN > 0 && process.env.MIGRATE_FOOTBALL_ALLOW_BET_ORPHAN === '1') {
      console.warn('[migrate] NULLing fixture_id on bet_selections that reference fixtures…');
      await dest.query(`UPDATE bet_selections SET fixture_id = NULL WHERE fixture_id IS NOT NULL`);
    }

    const dClient = await dest.connect();
    try {
      await dClient.query('BEGIN');
      for (const sql of DELETE_ORDER) {
        try {
          await dClient.query(sql);
        } catch (e) {
          console.warn('[migrate] delete step warn:', sql.slice(0, 40), (e).message);
        }
      }
      await dClient.query('COMMIT');
    } catch (e) {
      await dClient.query('ROLLBACK');
      throw e;
    } finally {
      dClient.release();
    }

    for (const table of COPY_ORDER) {
      await copyTable(src, dest, table);
    }

    await resetSequences(dest);

    const { rows: fin } = await dest.query(
      `SELECT
        (SELECT COUNT(*)::int FROM fixtures) AS fixtures,
        (SELECT COUNT(*)::int FROM odds) AS odds,
        (SELECT COUNT(*)::int FROM fixtures f WHERE EXISTS (SELECT 1 FROM odds o WHERE o.fixture_id = f.id)) AS with_odds`
    );
    console.log('[migrate] Done. DEST:', fin[0]);
  } finally {
    await src.end();
    await dest.end();
  }
}

main().catch((e) => {
  console.error('[migrate]', e);
  process.exit(1);
});
