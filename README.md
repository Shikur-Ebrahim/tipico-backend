# tipico-backend

Express + TypeScript API for the Tipico betting app (PostgreSQL, API-Football sync, JWT auth).

Optional: `FIXTURE_LIST_ALL_IN_DB`, `DATABASE_SSL` (set `true` if Postgres connects but TLS errors on Render).

## Render Web + Vercel (or any hosted frontend)

1. **Backend (Render):** `DATABASE_URL` = **Internal** URL from the same Render Postgres. `JWT_SECRET`, `FOOTBALL_API_KEY`, `NODE_ENV=production`. Root directory `backend` if the repo is monorepo; build `npm install && npm run build`; start `npm start`.
2. **Smoke test:** open `https://YOUR-API.onrender.com/api/health` — expect `"db": true` and `fixture_count` after sync. If `"db": false`, fix DB URL / SSL (`DATABASE_SSL=true` or add `?sslmode=require` to the URL).
3. **Frontend (Vercel):** Environment variable **`NEXT_PUBLIC_API_URL`** = your Render API base, e.g. `https://YOUR-API.onrender.com` **or** `https://YOUR-API.onrender.com/api` (both work). **Redeploy** after changing env vars so Next.js bakes them in.
4. **HTTPS:** use `https://` for the API URL in production (mixed content blocks `http` API from an `https` site).

## Local development

```bash
npm install
cp .env.example .env
# Edit .env: DATABASE_URL, FOOTBALL_API_KEY, JWT_SECRET
npm run dev
```

Health check: `GET /api/health`

## Deploy on Render (Web Service)

1. Connect this repository; **root directory** can stay empty if `package.json` is at the repo root.
2. **Build command:** `npm install && npm run build`
3. **Start command:** `npm start`

### Database URL (internal vs external)

- **Web Service + Postgres both on Render:** use the **Internal Database URL** as `DATABASE_URL` in the Web Service environment. Traffic stays on Render’s private network, avoids exposing the DB host to the public internet, and does not consume your machine’s bandwidth.
- **Local laptop → Render Postgres:** use the **External Database URL** (and `?sslmode=require` if not already in the string). Internal hostnames are not reachable from your PC.

In either case, this project expects a URL that enables TLS when `sslmode=require` is present (see `src/config/database.ts`).

### Required env vars on Render

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Internal (service on Render) or external (local dev only) |
| `JWT_SECRET` | Strong random string |
| `FOOTBALL_API_KEY` | API-Football key for sync jobs |

Optional: `API_FOOTBALL_HOST`, `FOOTBALL_CURRENT_SEASON`, `ODDS_SYNC_BATCH`, `BOOTSTRAP_FIXTURES_BY_DATE`, `BOOTSTRAP_ODDS_BY_DATE` — see `.env.example`.

### Secure admin account (production)

Do **not** put admin phone/password in Render’s long-lived environment variables (they appear in logs and dashboards).

**Recommended flow:**

1. Pick a **strong password** (password manager or long random string). Use a **real phone string** exactly as users will type it at login (e.g. `+251912345678` or `912345678` — must match the `users.phone` row).
2. On your **PC**, in `backend/.env`, set **`DATABASE_URL`** to the Postgres **External** URL (internal DB URLs do not work from your laptop).
3. Run **once**, then **unset** the env vars (do not save passwords in `.env`).

   **Promote an existing user (keeps their signup password):**

   ```powershell
   $env:SET_ADMIN_PHONE="912123432"
   npm run admin:set
   ```

   **Create admin or reset password:**

   ```powershell
   $env:SET_ADMIN_PHONE="+251912345678"
   $env:SET_ADMIN_PASSWORD="(strong password here)"
   npm run admin:set
   ```

4. Log in via **`POST /api/auth/login`** with that phone and password; the JWT will carry `role: 'admin'`.
5. **Rotate** the password if it was ever pasted in chat or shared.

The script hashes the password with bcrypt and either updates an existing user’s `role` + `password_hash` or creates an admin + wallet. See `scripts/set-admin-once.js`.

## Copy football data local → Render (fast)

API sync is slow for hundreds of matches. To **bulk-copy** fixtures + odds (and related rows) from your **local** DB into **Render** so production matches what works on your PC:

1. In the [Render dashboard](https://dashboard.render.com), open your Postgres → copy the **External Database URL** (your laptop cannot use the internal hostname).
2. From **PowerShell**, set **`SOURCE_DATABASE_URL`** to your local DB (the one that already has matches), **`DATABASE_URL`** to the Render **external** URL, then run the migration (env vars you set here override `backend/.env` for this command only):

   ```powershell
   cd d:\projects\tipico\backend   # or your clone path
   $env:SOURCE_DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/YOUR_LOCAL_DB"
   $env:DATABASE_URL="postgresql://USER:PASSWORD@HOST.region-postgres.render.com/YOUR_DB?sslmode=require"
   $env:MIGRATE_FOOTBALL_CONFIRM="yes"
   npm run migrate:football
   ```

3. If the script refuses because of **`bet_selections`** tied to fixtures, either clear test bets on Render first or set **`MIGRATE_FOOTBALL_ALLOW_BET_ORPHAN=1`** (see script header — this NULLs those `fixture_id` values).
4. After a successful run, set **`DATABASE_URL`** back in `backend/.env` to whatever you use for local dev (usually local Postgres).

Script: `scripts/migrate-football-local-to-dest.js` (deletes football-related rows on **dest**, then inserts from **source** in FK order).

## Database bootstrap

After creating an empty Postgres instance, apply `src/db/schema.sql` plus extras, or from this repo run `npm run db:apply-remote` once with `DATABASE_URL` set (see `scripts/apply-cloud-bootstrap.js`).

## Scripts

| Script | Purpose |
|--------|--------|
| `npm run db:verify-remote` | Sanity-check DB connectivity and core tables |
| `npm run db:apply-remote` | Apply schema + deposit/ticket extras (idempotent) |
| `npm run sync:fill-week` | Bootstrap 7d + repeated odds passes (`ODDS_SYNC_BATCH`, `SYNC_FILL_ODDS_PASSES` env) |
| `npm run migrate:football` | Bulk-copy football tables from `SOURCE_DATABASE_URL` → `DATABASE_URL` (see README) |
