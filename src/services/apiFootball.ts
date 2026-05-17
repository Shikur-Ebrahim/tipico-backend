import axios from 'axios';
import pool from '../config/database';
import { consumeApiRequest, getApiUsageStatus } from './apiQuota';

const API_HOST = process.env.API_FOOTBALL_HOST || 'v3.football.api-sports.io';
const API_BASE = `https://${API_HOST}`;
const API_KEY = process.env.FOOTBALL_API_KEY || '';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'x-apisports-key': API_KEY,
  },
  timeout: 15000,
});

type ApiSeason = {
  year?: number;
  current?: boolean;
  start?: string;
  end?: string;
};

type ApiLeague = {
  id?: number;
  name?: string;
  type?: string;
  logo?: string;
};

type ApiCountry = {
  name?: string;
  code?: string;
  flag?: string;
};

type ApiTeam = {
  id?: number;
  name?: string;
  logo?: string;
  country?: string;
  founded?: number;
};

type ApiVenue = {
  name?: string;
  city?: string;
  capacity?: number;
  image?: string;
};

type ApiFixture = {
  id?: number;
  date?: string;
  referee?: string;
  status?: {
    short?: string;
    elapsed?: number;
  };
  venue?: ApiVenue;
};

type ApiFixtureResponseItem = {
  fixture?: ApiFixture;
  /** API-Football embeds `country` (name) and `season` (year) on fixture responses. */
  league?: ApiLeague & { season?: number; country?: string };
  teams?: {
    home?: ApiTeam;
    away?: ApiTeam;
  };
  goals?: {
    home?: number;
    away?: number;
  };
};

type PersistableCountry = ApiCountry | { name?: string; code?: string; flag_url?: string };
const FIXTURE_WINDOW_DAYS = Math.min(
  30,
  Math.max(1, parseInt(process.env.FIXTURE_WINDOW_DAYS || '7', 10) || 7)
);

type ApiSportsPaged<T> = {
  response: T[];
  paging?: { current: number; total: number };
};

/**
 * API-Sports returns one page per request; total pages in `paging.total`.
 * Without this, most fixture/odds lists are truncated (~10–20 per page).
 */
async function apiGetAllPages<TItem>(
  endpoint: string,
  baseParams: Record<string, string | number>,
  options?: { paginate?: boolean }
): Promise<TItem[]> {
  if (options?.paginate === false) {
    const data = await apiGet<ApiSportsPaged<TItem>>(endpoint, baseParams);
    return Array.isArray(data.response) ? data.response : [];
  }

  const out: TItem[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = await apiGet<ApiSportsPaged<TItem>>(endpoint, { ...baseParams, page });
    const chunk = Array.isArray(data.response) ? data.response : [];
    out.push(...chunk);
    const reportedTotal = data.paging?.total;
    totalPages =
      typeof reportedTotal === 'number' && reportedTotal >= 1 ? reportedTotal : 1;
    page += 1;
    if (!data.paging && chunk.length === 0) {
      break;
    }
  }

  return out;
}

async function apiGet<T>(endpoint: string, params?: Record<string, string | number>) {
  if (!API_KEY) {
    throw new Error('FOOTBALL_API_KEY is not configured');
  }

  await consumeApiRequest(endpoint);
  const { data } = await api.get<T>(endpoint, { params });
  return data;
}

function toDate(value?: string | null) {
  return value ? new Date(value) : null;
}

function formatApiDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** YYYY-MM-DD in local time — matches rolling window from `getFixtureWindowRange()`. */
function formatLocalYmd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getFixtureWindowRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  // Rolling window: [start, start + FIXTURE_WINDOW_DAYS). Default 7 days; override with env FIXTURE_WINDOW_DAYS (max 30).
  const endExclusive = new Date(start);
  endExclusive.setDate(start.getDate() + FIXTURE_WINDOW_DAYS);

  const endInclusive = new Date(endExclusive.getTime() - 1);

  return { start, endInclusive, endExclusive };
}

function isWithinFixtureWindow(value?: string | null) {
  if (!value) {
    return false;
  }

  const fixtureDate = new Date(value);
  if (Number.isNaN(fixtureDate.getTime())) {
    return false;
  }

  const { start, endExclusive } = getFixtureWindowRange();
  return fixtureDate >= start && fixtureDate < endExclusive;
}

function getCountryFlag(country: PersistableCountry) {
  if ('flag' in country) {
    return country.flag || null;
  }

  return (country as { flag_url?: string }).flag_url || null;
}

async function ensureCountry(country: PersistableCountry) {
  if (!country.name) {
    return null;
  }

  const existingCountry = await pool.query(
    `SELECT id FROM countries
     WHERE name = $1
       AND ($2::varchar IS NULL OR code = $2 OR code IS NULL)
     ORDER BY id ASC
     LIMIT 1`,
    [country.name, country.code || null]
  );

  if (existingCountry.rows[0]?.id) {
    await pool.query(
      `UPDATE countries
       SET code = COALESCE($2, code),
           flag_url = COALESCE($3, flag_url)
       WHERE id = $1`,
      [
        existingCountry.rows[0].id,
        country.code || null,
        getCountryFlag(country),
      ]
    );

    return existingCountry.rows[0].id as number;
  }

  const { rows } = await pool.query(
    `INSERT INTO countries (name, code, flag_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (name, code) DO UPDATE SET
       flag_url = COALESCE(EXCLUDED.flag_url, countries.flag_url)
     RETURNING id`,
    [country.name, country.code || null, getCountryFlag(country)]
  );

  return rows[0].id as number;
}

async function ensureLeague(
  league: ApiLeague,
  countryId: number | null,
  currentSeason: ApiSeason | null,
  topRank?: number
) {
  if (!league.id) {
    return null;
  }

  const { rows } = await pool.query(
    `INSERT INTO leagues (country_id, name, logo, type, season_current, api_league_id, is_top, top_rank)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (api_league_id) DO UPDATE SET
       country_id = COALESCE(EXCLUDED.country_id, leagues.country_id),
       name = COALESCE(EXCLUDED.name, leagues.name),
       logo = COALESCE(EXCLUDED.logo, leagues.logo),
       type = COALESCE(EXCLUDED.type, leagues.type),
       season_current = COALESCE(EXCLUDED.season_current, leagues.season_current),
       is_top = EXCLUDED.is_top,
       top_rank = EXCLUDED.top_rank
     RETURNING id`,
    [
      countryId,
      league.name || null,
      league.logo || null,
      league.type || null,
      currentSeason?.year ? String(currentSeason.year) : null,
      league.id,
      topRank !== undefined,
      topRank ?? null,
    ]
  );

  return rows[0].id as number;
}

/**
 * `/fixtures?date=` returns matches for many leagues; `fetchAndStoreLeagues` only
 * persists a subset (first `/leagues` page + top IDs). Upsert league from the fixture
 * payload so rolling-window sync can store the full set into the DB.
 */
async function ensureLeagueFromFixturePayload(
  league: NonNullable<ApiFixtureResponseItem['league']>,
  teams: ApiFixtureResponseItem['teams']
): Promise<number | null> {
  if (!league.id) {
    return null;
  }

  const existing = await pool.query('SELECT id FROM leagues WHERE api_league_id = $1', [league.id]);
  if (existing.rows[0]?.id) {
    return existing.rows[0].id as number;
  }

  const countryName = league.country || teams?.home?.country || teams?.away?.country;
  const countryId = countryName ? await ensureCountry({ name: countryName }) : null;

  const seasonYear = typeof league.season === 'number' ? league.season : undefined;
  const currentSeason =
    seasonYear !== undefined ? { year: seasonYear, current: true as const } : null;

  await ensureLeague(league, countryId, currentSeason, undefined);

  const after = await pool.query('SELECT id FROM leagues WHERE api_league_id = $1', [league.id]);
  return (after.rows[0]?.id as number) ?? null;
}

async function ensureSeason(leagueId: number, season: ApiSeason | { year?: number | string; start?: string | null; end?: string | null; current?: boolean }) {
  const yearValue = season.year ? String(season.year) : null;
  if (!yearValue) {
    return null;
  }

  const { rows } = await pool.query(
    `INSERT INTO seasons (league_id, year, start_date, end_date, is_current)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (league_id, year) DO UPDATE SET
       start_date = COALESCE(EXCLUDED.start_date, seasons.start_date),
       end_date = COALESCE(EXCLUDED.end_date, seasons.end_date),
       is_current = EXCLUDED.is_current
     RETURNING id`,
    [leagueId, yearValue, toDate(season.start || null), toDate(season.end || null), Boolean(season.current)]
  );

  return rows[0].id as number;
}

async function ensureTeam(team: ApiTeam, leagueId: number | null = null, countryId: number | null = null) {
  if (!team.id) {
    return null;
  }

  const { rows } = await pool.query(
    `INSERT INTO teams (league_id, country_id, name, logo, founded, api_team_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (api_team_id) DO UPDATE SET
       league_id = COALESCE(EXCLUDED.league_id, teams.league_id),
       country_id = COALESCE(EXCLUDED.country_id, teams.country_id),
       name = COALESCE(EXCLUDED.name, teams.name),
       logo = COALESCE(EXCLUDED.logo, teams.logo),
       founded = COALESCE(EXCLUDED.founded, teams.founded)
     RETURNING id`,
    [leagueId, countryId, team.name || null, team.logo || null, team.founded || null, team.id]
  );

  return rows[0].id as number;
}

async function ensureVenue(venue: ApiVenue | undefined) {
  if (!venue?.name || !venue.city) {
    return null;
  }

  const { rows } = await pool.query(
    `INSERT INTO venues (name, city, capacity, image)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name, city) DO UPDATE SET
       capacity = COALESCE(EXCLUDED.capacity, venues.capacity),
       image = COALESCE(EXCLUDED.image, venues.image)
     RETURNING id`,
    [venue.name, venue.city, venue.capacity || null, venue.image || null]
  );

  return rows[0].id as number;
}

async function ensureFixtureRecord(item: ApiFixtureResponseItem) {
  const fixture = item.fixture;
  const league = item.league;
  const teams = item.teams;
  if (!fixture?.id || !league?.id || !teams?.home || !teams.away) {
    return null;
  }

  if (!isWithinFixtureWindow(fixture.date)) {
    return null;
  }

  const leagueId = await ensureLeagueFromFixturePayload(league, teams);
  if (!leagueId) {
    return null;
  }

  const seasonId = await ensureSeason(leagueId, {
    year: league.season,
    current: true,
  });

  const homeCountryId = teams.home.country ? await ensureCountry({ name: teams.home.country }) : null;
  const awayCountryId = teams.away.country ? await ensureCountry({ name: teams.away.country }) : null;
  const homeTeamId = await ensureTeam(teams.home, leagueId, homeCountryId);
  const awayTeamId = await ensureTeam(teams.away, leagueId, awayCountryId);
  const venueId = await ensureVenue(fixture.venue);

  const { rows } = await pool.query(
    `INSERT INTO fixtures (
       league_id, season_id, home_team_id, away_team_id, venue_id,
       match_date, status, minute, home_score, away_score, referee, api_fixture_id, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (api_fixture_id) DO UPDATE SET
       league_id = EXCLUDED.league_id,
       season_id = EXCLUDED.season_id,
       home_team_id = EXCLUDED.home_team_id,
       away_team_id = EXCLUDED.away_team_id,
       venue_id = COALESCE(EXCLUDED.venue_id, fixtures.venue_id),
       match_date = EXCLUDED.match_date,
       status = EXCLUDED.status,
       minute = EXCLUDED.minute,
       home_score = EXCLUDED.home_score,
       away_score = EXCLUDED.away_score,
       referee = COALESCE(EXCLUDED.referee, fixtures.referee),
       updated_at = NOW()
     RETURNING id`,
    [
      leagueId,
      seasonId,
      homeTeamId,
      awayTeamId,
      venueId,
      toDate(fixture.date),
      fixture.status?.short || null,
      fixture.status?.elapsed || null,
      item.goals?.home ?? 0,
      item.goals?.away ?? 0,
      fixture.referee || null,
      fixture.id,
    ]
  );

  return rows[0].id as number;
}

export async function fetchAndStoreCountries() {
  const data = await apiGet<{ response: ApiCountry[] }>('/countries');
  for (const country of data.response) {
    await ensureCountry(country);
  }
}

export async function fetchAndStoreLeagues(topLeagueIds: number[] = []) {
  const topRanks = new Map<number, number>();
  topLeagueIds.forEach((id, index) => topRanks.set(id, index + 1));

  const data = await apiGet<{ response: Array<{ league: ApiLeague; country: ApiCountry; seasons?: ApiSeason[] }> }>('/leagues');
  for (const item of data.response) {
    const currentSeason = item.seasons?.find((season) => season.current) || item.seasons?.[0] || null;
    const countryId = await ensureCountry(item.country);
    await ensureLeague(item.league, countryId, currentSeason, item.league.id ? topRanks.get(item.league.id) : undefined);
  }
}

/** Fetch only listed league IDs (fast; avoids processing entire /leagues catalog). */
export async function fetchAndStoreLeaguesByIds(topLeagueIds: number[]) {
  const topRanks = new Map<number, number>();
  topLeagueIds.forEach((id, index) => topRanks.set(id, index + 1));

  for (const leagueId of topLeagueIds) {
    const data = await apiGet<{
      response: Array<{ league: ApiLeague; country: ApiCountry; seasons?: ApiSeason[] }>;
    }>('/leagues', { id: leagueId });
    for (const item of data.response) {
      const currentSeason = item.seasons?.find((season) => season.current) || item.seasons?.[0] || null;
      const countryId = await ensureCountry(item.country);
      await ensureLeague(item.league, countryId, currentSeason, topRanks.get(leagueId));
    }
  }
}

export async function fetchAndStoreTeams(leagueApiId: number, season: number) {
  const leagueRow = await pool.query('SELECT id FROM leagues WHERE api_league_id = $1', [leagueApiId]);
  const leagueId = leagueRow.rows[0]?.id as number | undefined;
  if (!leagueId) {
    return;
  }

  const data = await apiGet<{ response: Array<{ team: ApiTeam; venue?: ApiVenue }> }>('/teams', { league: leagueApiId, season });
  for (const item of data.response) {
    const countryId = item.team.country ? await ensureCountry({ name: item.team.country }) : null;
    await ensureTeam(item.team, leagueId, countryId);
    await ensureVenue(item.venue);
  }
}

export async function fetchAndStoreFixtures(leagueApiId: number, season: number) {
  const { start, endInclusive } = getFixtureWindowRange();
  const items = await apiGetAllPages<ApiFixtureResponseItem>('/fixtures', {
    league: leagueApiId,
    season,
    from: formatApiDate(start),
    to: formatApiDate(endInclusive),
  });
  for (const item of items) {
    await ensureFixtureRecord(item);
  }
}

export async function fetchAndStoreFixturesForRollingWindow() {
  const enabled = process.env.BOOTSTRAP_FIXTURES_BY_DATE !== '0' && process.env.BOOTSTRAP_FIXTURES_BY_DATE !== 'false';
  if (!enabled) {
    return { days: 0, fixturesSeen: 0 };
  }

  const { start, endExclusive } = getFixtureWindowRange();
  let fixturesSeen = 0;
  const cursor = new Date(start);

  while (cursor < endExclusive) {
    const dateStr = formatLocalYmd(cursor);
    const items = await apiGetAllPages<ApiFixtureResponseItem>(
      '/fixtures',
      { date: dateStr },
      { paginate: false }
    );
    for (const item of items) {
      await ensureFixtureRecord(item);
    }
    fixturesSeen += items.length;
    cursor.setDate(cursor.getDate() + 1);
  }

  return { days: FIXTURE_WINDOW_DAYS, fixturesSeen };
}

type BulkOddsApiItem = {
  fixture: { id: number };
  bookmakers?: Array<{
    id?: number;
    name?: string;
    bets?: Array<{
      id?: string | number;
      name?: string;
      values?: Array<{ value?: string; odd?: string }>;
    }>;
  }>;
};

async function persistBulkOddsApiItem(item: BulkOddsApiItem) {
  const fixtureApiId = item.fixture.id;
  const fixtureResult = await pool.query('SELECT id FROM fixtures WHERE api_fixture_id = $1', [fixtureApiId]);
  const fixtureId = fixtureResult.rows[0]?.id as number | undefined;
  if (!fixtureId) return;

  for (const bookmaker of item.bookmakers || []) {
    if (!bookmaker.id) continue;

    const bookmakerRes = await pool.query(
      `INSERT INTO bookmakers (name, api_bookmaker_id)
       VALUES ($1, $2)
       ON CONFLICT (api_bookmaker_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, bookmakers.name)
       RETURNING id`,
      [bookmaker.name || null, bookmaker.id]
    );
    const bookmakerId = bookmakerRes.rows[0].id;

    for (const bet of bookmaker.bets || []) {
      if (!bet.name) continue;
      const betRes = await pool.query(
        `INSERT INTO bet_markets (name, market_key)
         VALUES ($1, $2)
         ON CONFLICT (market_key) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [bet.name, String(bet.id || bet.name).toLowerCase().replace(/\s+/g, '_')]
      );
      const marketId = betRes.rows[0].id;

      for (const val of bet.values || []) {
        if (!val.value || !val.odd) continue;

        const oddsIdRes = await pool.query(
          `INSERT INTO odds (fixture_id, bookmaker_id, market_id, selection, odd_value)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (fixture_id, bookmaker_id, market_id, selection) DO UPDATE SET
             odd_value = EXCLUDED.odd_value,
             last_update = NOW()
           RETURNING id`,
          [fixtureId, bookmakerId, marketId, val.value, parseFloat(val.odd)]
        );

        await pool.query(
          `INSERT INTO odds_history (odds_id, new_value)
           VALUES ($1, $2)`,
          [oddsIdRes.rows[0].id, parseFloat(val.odd)]
        );
      }
    }
  }
}

export async function fetchAndStoreBulkOddsByDate(dateStr: string) {
  const items = await apiGetAllPages<BulkOddsApiItem>('/odds', { date: dateStr }, { paginate: false });
  for (const item of items) {
    await persistBulkOddsApiItem(item);
  }
  return items.length;
}

export async function fetchAndStoreBulkOddsForRollingWindowByDate() {
  const enabled = process.env.BOOTSTRAP_ODDS_BY_DATE !== '0' && process.env.BOOTSTRAP_ODDS_BY_DATE !== 'false';
  if (!enabled) {
    return { days: 0, oddsRowsSeen: 0 };
  }

  const { start, endExclusive } = getFixtureWindowRange();
  let oddsRowsSeen = 0;
  const cursor = new Date(start);

  while (cursor < endExclusive) {
    const dateStr = formatLocalYmd(cursor);
    try {
      const n = await fetchAndStoreBulkOddsByDate(dateStr);
      oddsRowsSeen += n;
    } catch (err) {
      console.warn(`[SYNC] Odds by date skipped for ${dateStr}:`, err instanceof Error ? err.message : err);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return { days: FIXTURE_WINDOW_DAYS, oddsRowsSeen };
}

export async function fetchAndStoreBulkOdds(leagueApiId: number, season: number) {
  const items = await apiGetAllPages<BulkOddsApiItem>('/odds', { league: leagueApiId, season });

  for (const item of items) {
    await persistBulkOddsApiItem(item);
  }
}

export async function fetchAndStoreOdds(fixtureApiId: number) {
  const fixtureResult = await pool.query('SELECT id FROM fixtures WHERE api_fixture_id = $1', [fixtureApiId]);
  const fixtureId = fixtureResult.rows[0]?.id as number | undefined;
  if (!fixtureId) {
    return;
  }

  const data = await apiGet<{
    response: Array<{
      bookmakers?: Array<{
        id?: number;
        name?: string;
        bets?: Array<{
          id?: string | number;
          name?: string;
          values?: Array<{ value?: string; odd?: string }>;
        }>;
      }>;
    }>;
  }>('/odds', { fixture: fixtureApiId });

  for (const item of data.response) {
    for (const bookmaker of item.bookmakers || []) {
      if (!bookmaker.id) {
        continue;
      }

      const bookmakerRes = await pool.query(
        `INSERT INTO bookmakers (name, api_bookmaker_id)
         VALUES ($1, $2)
         ON CONFLICT (api_bookmaker_id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, bookmakers.name)
         RETURNING id`,
        [bookmaker.name || null, bookmaker.id]
      );
      const bookmakerId = bookmakerRes.rows[0].id as number;

      for (const bet of bookmaker.bets || []) {
        if (!bet.name && bet.id == null) {
          continue;
        }

        const marketKey = String(bet.id ?? bet.name)
          .toLowerCase()
          .replace(/\s+/g, '_');

        const marketRes = await pool.query(
          `INSERT INTO bet_markets (name, market_key)
           VALUES ($1, $2)
           ON CONFLICT (market_key) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, bet_markets.name)
           RETURNING id`,
          [bet.name || null, marketKey]
        );
        const marketId = marketRes.rows[0].id as number;

        for (const value of bet.values || []) {
          if (!value.value || !value.odd) {
            continue;
          }

          const previous = await pool.query(
            `SELECT id, odd_value FROM odds
             WHERE fixture_id = $1 AND bookmaker_id = $2 AND market_id = $3 AND selection = $4`,
            [fixtureId, bookmakerId, marketId, value.value]
          );

          const oddValue = Number(value.odd);
          const oddRes = await pool.query(
            `INSERT INTO odds (fixture_id, bookmaker_id, market_id, selection, odd_value, last_update)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (fixture_id, bookmaker_id, market_id, selection) DO UPDATE SET
               odd_value = EXCLUDED.odd_value,
               last_update = NOW()
             RETURNING id`,
            [fixtureId, bookmakerId, marketId, value.value, oddValue]
          );

          if (previous.rows[0] && Number(previous.rows[0].odd_value) !== oddValue) {
            await pool.query(
              `INSERT INTO odds_history (odds_id, old_value, new_value, changed_at)
               VALUES ($1, $2, $3, NOW())`,
              [oddRes.rows[0].id, previous.rows[0].odd_value, oddValue]
            );
          }
        }
      }
    }
  }
}




const fixtureRefreshAt = new Map<number, number>();
/** Min gap between on-demand API pulls for the same fixture (match detail polls ~30s). */
const FIXTURE_REFRESH_MIN_MS = 25_000;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

/**
 * Pull latest fixture + odds from API-Football for one DB fixture (throttled per fixture).
 * Used by match detail refresh so scores/status/odds stay current while the game is live.
 */
export async function refreshFixtureAndOddsFromApi(
  internalFixtureId: number,
  options?: { force?: boolean }
): Promise<{ skipped: boolean; reason?: string }> {
  const now = Date.now();
  if (!options?.force) {
    const last = fixtureRefreshAt.get(internalFixtureId) || 0;
    if (now - last < FIXTURE_REFRESH_MIN_MS) {
      return { skipped: true, reason: 'rate_limited' };
    }
  }

  const { rows } = await pool.query<{
    api_fixture_id: number | null;
    status: string | null;
    match_date: Date;
  }>(`SELECT api_fixture_id, status, match_date FROM fixtures WHERE id = $1`, [internalFixtureId]);

  const row = rows[0];
  if (!row?.api_fixture_id) {
    return { skipped: true, reason: 'not_found' };
  }

  const status = row.status || '';
  const kickoff = new Date(row.match_date).getTime();
  if (FINISHED_STATUSES.has(status) && Date.now() - kickoff > 6 * 60 * 60 * 1000) {
    return { skipped: true, reason: 'archived' };
  }

  fixtureRefreshAt.set(internalFixtureId, Date.now());

  const data = await apiGet<{ response: ApiFixtureResponseItem[] }>('/fixtures', {
    id: row.api_fixture_id,
  });
  const item = data.response?.[0];
  if (!item) {
    return { skipped: true, reason: 'api_empty' };
  }

  await ensureFixtureRecord(item);
  await fetchAndStoreOdds(row.api_fixture_id);

  return { skipped: false };
}

/**
 * Intentionally a no-op: API-Football is only called from backend sync jobs (cron / scripts),
 * not from read routes or the frontend. Use `refreshFixtureAndOddsFromApi` from an admin script if needed.
 */
export async function syncFixtureDetailsIfMissing(_fixtureId: number) {
  // no-op
}

export async function fetchAndStoreInjuries(leagueId: number, season: number) {
  try {
    const data = await apiGet<{ response: any[] }>('/injuries', { league: leagueId, season });
    // This is a bulk update for the league/season
    for (const item of data.response) {
      const teamId = await ensureTeam(item.team);
      if (!teamId) continue;
      
      // Upsert into injuries
      await pool.query(
        `INSERT INTO injuries (team_id, injury_type, reason, status)
         VALUES ($1, $2, $3, 'Active')
         ON CONFLICT DO NOTHING`, // Simple version for now
        [teamId, item.player.type || 'Injury', item.player.reason || null]
      );
    }
  } catch (err) {
    console.error(`[SYNC] Failed to fetch injuries:`, err);
  }
}

export async function fetchAndStoreLiveMatches() {
  const data = await apiGet<{ response: ApiFixtureResponseItem[] }>('/fixtures', { live: 'all' });
  const activeFixtureIds: number[] = [];

  for (const item of data.response) {
    const fixtureId = await ensureFixtureRecord(item);
    if (!fixtureId) {
      continue;
    }

    activeFixtureIds.push(fixtureId);
    await pool.query(
      `INSERT INTO live_matches (fixture_id, status, minute, home_score, away_score, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (fixture_id) DO UPDATE SET
         status = EXCLUDED.status,
         minute = EXCLUDED.minute,
         home_score = EXCLUDED.home_score,
         away_score = EXCLUDED.away_score,
         is_active = true`,
      [
        fixtureId,
        item.fixture?.status?.short || null,
        item.fixture?.status?.elapsed || null,
        item.goals?.home ?? 0,
        item.goals?.away ?? 0,
      ]
    );
  }

  if (activeFixtureIds.length > 0) {
    await pool.query(
      `UPDATE live_matches SET is_active = false WHERE fixture_id <> ALL($1::int[])`,
      [activeFixtureIds]
    );
  } else {
    await pool.query('UPDATE live_matches SET is_active = false');
  }
}

export async function getFootballApiUsage() {
  return getApiUsageStatus();
}
