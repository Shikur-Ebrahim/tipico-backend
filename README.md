# tipico-backend

Express + TypeScript API for the Tipico betting app (PostgreSQL on Render, API-Football sync, JWT auth).

Optional: `FIXTURE_LIST_ALL_IN_DB`, `DATABASE_SSL` (set `true` if Postgres connects but TLS errors on Render).

## Render (API + Postgres)

1. **Web Service:** `DATABASE_URL` = **Internal** URL from the same Render Postgres instance. Set `JWT_SECRET`, `FOOTBALL_API_KEY`, `NODE_ENV=production`. Monorepo: **Root Directory** = `backend`. **Build:** `npm install && npm run build`. **Start:** `npm start`.
2. **Smoke test:** `https://YOUR-API.onrender.com/api/health` — expect `"db": true` and `fixture_count` after sync. If `"db": false`, fix `DATABASE_URL` / SSL (`DATABASE_SSL=true` or `?sslmode=require` on the URL).
3. **Vercel frontend:** set **`NEXT_PUBLIC_API_URL`** to your Render API (`https://YOUR-API.onrender.com` or `https://YOUR-API.onrender.com/api`). Redeploy the frontend after env changes.
4. **HTTPS:** the API URL exposed to the browser must use `https://` (mixed content blocks `http` from an `https` site).

## Deploy on Render (Web Service)

1. Connect this repository. If the API is in a subfolder, set **Root Directory** to **`backend`**. Leave empty only when `package.json` is at the repository root.
2. **Build command:** `npm install && npm run build`
3. **Start command:** `npm start`

### Database URL

- **Web Service + Postgres on Render:** use the **Internal Database URL** as `DATABASE_URL` on the Web Service (private network between services).
- **One-off scripts** (`admin:set`, `db:apply-remote`, `migrate:football`, etc.): use the **External Database URL** from the Render dashboard with TLS (`?sslmode=require` if not already present). Internal hostnames are not reachable from outside Render’s network.

TLS is enabled when `sslmode=require` appears in the URL, when `DATABASE_SSL=true`, or when the host is on Render (`src/config/database.ts`).

### Required env vars on Render

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | **Internal** URL on the Web Service |
| `JWT_SECRET` | Strong random string |
| `FOOTBALL_API_KEY` | API-Football key for sync jobs |

Optional: `API_FOOTBALL_HOST`, `FOOTBALL_CURRENT_SEASON`, `ODDS_SYNC_BATCH`, `BOOTSTRAP_FIXTURES_BY_DATE`, `BOOTSTRAP_ODDS_BY_DATE` — see `.env.example`.

### Secure admin account (production)

Do **not** put admin phone/password in Render’s long-lived environment variables (they appear in logs and dashboards).

**Recommended flow:**

1. Pick a **strong password** and a **phone string** exactly as users will type it at login (must match `users.phone`).
2. Run **`npm run admin:set`** once with **`DATABASE_URL`** set to the Postgres **external** URL (shell env for that command only), plus `SET_ADMIN_PHONE` / optional `SET_ADMIN_PASSWORD`. Do not leave passwords in a committed `.env`.
3. Log in via **`POST /api/auth/login`**; the JWT will carry `role: 'admin'` when promoted.
4. **Rotate** the password if it was ever exposed.

```powershell
$env:DATABASE_URL="postgresql://USER:PASSWORD@HOST.region-postgres.render.com/YOUR_DB?sslmode=require"
$env:SET_ADMIN_PHONE="912123432"
npm run admin:set
```

See `scripts/set-admin-once.js`.

## Optional: bulk-copy football tables between databases

To copy fixtures + odds from one Postgres (`SOURCE_DATABASE_URL`) into another (`DATABASE_URL`), see `scripts/migrate-football-local-to-dest.js`. Set `MIGRATE_FOOTBALL_CONFIRM=yes`. Clear temporary credentials after the run.

## Database bootstrap

After creating an empty Postgres instance, apply `src/db/schema.sql` plus extras, or run `npm run db:apply-remote` once with `DATABASE_URL` set (see `scripts/apply-cloud-bootstrap.js`).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run db:verify-remote` | Sanity-check DB connectivity and core tables |
| `npm run db:apply-remote` | Apply schema + deposit/ticket extras (idempotent) |
| `npm run sync:fill-week` | Bootstrap 7d + repeated odds passes (`ODDS_SYNC_BATCH`, `SYNC_FILL_ODDS_PASSES` env) |
| `npm run migrate:football` | Bulk-copy football tables between two URLs (see script header) |
