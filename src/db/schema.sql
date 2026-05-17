-- =========================
-- FOOTBALL CORE
-- =========================

CREATE SCHEMA IF NOT EXISTS public;
SET search_path TO public;

CREATE TABLE IF NOT EXISTS countries (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  code VARCHAR(10),
  flag_url TEXT
);

CREATE TABLE IF NOT EXISTS api_request_usage (
  id SERIAL PRIMARY KEY,
  usage_date DATE NOT NULL,
  request_count INT DEFAULT 0,
  quota_limit INT DEFAULT 75000,
  last_endpoint VARCHAR(255),
  last_request_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leagues (
  id SERIAL PRIMARY KEY,
  country_id INT REFERENCES countries(id),
  name VARCHAR(150),
  logo TEXT,
  type VARCHAR(50),
  season_current VARCHAR(20),
  api_league_id INT,
  is_top BOOLEAN DEFAULT false,
  top_rank INT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  league_id INT REFERENCES leagues(id),
  year VARCHAR(20),
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  league_id INT REFERENCES leagues(id),
  country_id INT REFERENCES countries(id),
  name VARCHAR(150),
  logo TEXT,
  founded INT,
  api_team_id INT
);

CREATE TABLE IF NOT EXISTS venues (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150),
  city VARCHAR(100),
  capacity INT,
  image TEXT,
  country_id INT REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS fixtures (
  id SERIAL PRIMARY KEY,
  league_id INT REFERENCES leagues(id),
  season_id INT REFERENCES seasons(id),
  home_team_id INT REFERENCES teams(id),
  away_team_id INT REFERENCES teams(id),
  venue_id INT REFERENCES venues(id),
  match_date TIMESTAMP,
  status VARCHAR(20),
  minute INT,
  home_score INT DEFAULT 0,
  away_score INT DEFAULT 0,
  referee VARCHAR(100),
  api_fixture_id INT,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS standings (
  id SERIAL PRIMARY KEY,
  league_id INT REFERENCES leagues(id),
  season_id INT REFERENCES seasons(id),
  team_id INT REFERENCES teams(id),
  rank INT,
  played INT,
  won INT,
  draw INT,
  lost INT,
  goals_for INT,
  goals_against INT,
  goal_diff INT,
  points INT,
  form VARCHAR(20)
);

-- =========================
-- MATCH DETAILS
-- =========================

CREATE TABLE IF NOT EXISTS fixture_events (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  team_id INT REFERENCES teams(id),
  player_id INT,
  type VARCHAR(50),
  minute INT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS fixture_statistics (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  team_id INT REFERENCES teams(id),
  possession INT,
  shots_total INT,
  shots_on_target INT,
  corners INT,
  fouls INT,
  yellow_cards INT,
  red_cards INT
);

CREATE TABLE IF NOT EXISTS lineups (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  team_id INT REFERENCES teams(id),
  player_id INT,
  player_name VARCHAR(150),
  player_number INT,
  position VARCHAR(50),
  is_starting BOOLEAN
);

CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  team_id INT REFERENCES teams(id),
  name VARCHAR(150),
  age INT,
  nationality VARCHAR(100),
  photo TEXT,
  position VARCHAR(50),
  api_player_id INT
);

CREATE TABLE IF NOT EXISTS player_statistics (
  id SERIAL PRIMARY KEY,
  player_id INT REFERENCES players(id),
  fixture_id INT REFERENCES fixtures(id),
  goals INT,
  assists INT,
  shots INT,
  passes INT,
  rating DECIMAL(3,1),
  yellow_cards INT,
  red_cards INT
);

CREATE TABLE IF NOT EXISTS team_statistics (
  id SERIAL PRIMARY KEY,
  team_id INT REFERENCES teams(id),
  season_id INT REFERENCES seasons(id),
  matches_played INT,
  wins INT,
  draws INT,
  losses INT,
  goals_scored INT,
  goals_conceded INT,
  clean_sheets INT
);

CREATE TABLE IF NOT EXISTS injuries (
  id SERIAL PRIMARY KEY,
  player_id INT REFERENCES players(id),
  team_id INT REFERENCES teams(id),
  injury_type VARCHAR(100),
  reason TEXT,
  start_date DATE,
  expected_return DATE,
  status VARCHAR(50)
);

-- =========================
-- ODDS SYSTEM
-- =========================

CREATE TABLE IF NOT EXISTS bookmakers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  logo TEXT,
  api_bookmaker_id INT
);

CREATE TABLE IF NOT EXISTS bet_markets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  market_key VARCHAR(50),
  description TEXT
);

CREATE TABLE IF NOT EXISTS odds (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  bookmaker_id INT REFERENCES bookmakers(id),
  market_id INT REFERENCES bet_markets(id),
  selection VARCHAR(100),
  odd_value DECIMAL(5,2),
  last_update TIMESTAMP
);

CREATE TABLE IF NOT EXISTS odds_history (
  id SERIAL PRIMARY KEY,
  odds_id INT REFERENCES odds(id),
  old_value DECIMAL(5,2),
  new_value DECIMAL(5,2),
  changed_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_odds (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  market_id INT REFERENCES bet_markets(id),
  selection VARCHAR(100),
  odd_value DECIMAL(5,2),
  minute INT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =========================
-- LIVE SYSTEM
-- =========================

CREATE TABLE IF NOT EXISTS live_matches (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  status VARCHAR(20),
  minute INT,
  home_score INT,
  away_score INT,
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS live_events (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  minute INT,
  event_type VARCHAR(50),
  description TEXT
);

CREATE TABLE IF NOT EXISTS live_statistics (
  id SERIAL PRIMARY KEY,
  fixture_id INT REFERENCES fixtures(id),
  home_possession INT,
  away_possession INT,
  shots INT,
  corners INT
);

-- =========================
-- USERS & WALLET
-- =========================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(150),
  phone VARCHAR(20),
  password_hash TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  balance DECIMAL(10,2) DEFAULT 0,
  currency VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  type VARCHAR(50),
  amount DECIMAL(10,2),
  status VARCHAR(20),
  reference VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- =========================
-- BETTING SYSTEM
-- =========================

CREATE TABLE IF NOT EXISTS bet_slips (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  total_odds DECIMAL(5,2),
  stake DECIMAL(10,2),
  possible_win DECIMAL(10,2),
  status VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bet_selections (
  id SERIAL PRIMARY KEY,
  bet_slip_id INT REFERENCES bet_slips(id),
  fixture_id INT REFERENCES fixtures(id),
  market_id INT REFERENCES bet_markets(id),
  selection VARCHAR(100),
  odd DECIMAL(5,2),
  result VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS bet_results (
  id SERIAL PRIMARY KEY,
  bet_slip_id INT REFERENCES bet_slips(id),
  status VARCHAR(20),
  win_amount DECIMAL(10,2),
  settled_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cashout_requests (
  id SERIAL PRIMARY KEY,
  bet_slip_id INT REFERENCES bet_slips(id),
  offer_amount DECIMAL(10,2),
  status VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS winning_history (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  bet_slip_id INT REFERENCES bet_slips(id),
  amount DECIMAL(10,2),
  paid_at TIMESTAMP
);

-- =========================
-- INDEXES
-- =========================

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_request_usage_date ON api_request_usage(usage_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_countries_name_code ON countries(name, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leagues_api_league_id ON leagues(api_league_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seasons_league_year ON seasons(league_id, year);
CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_api_team_id ON teams(api_team_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_venues_name_city ON venues(name, city);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fixtures_api_fixture_id ON fixtures(api_fixture_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_standings_league_season_team ON standings(league_id, season_id, team_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookmakers_api_bookmaker_id ON bookmakers(api_bookmaker_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bet_markets_market_key ON bet_markets(market_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_fixture_bookmaker_market_selection ON odds(fixture_id, bookmaker_id, market_id, selection);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_matches_fixture_id ON live_matches(fixture_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_league ON fixtures(league_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_date ON fixtures(match_date);
CREATE INDEX IF NOT EXISTS idx_fixtures_date_status ON fixtures(match_date, status);
CREATE INDEX IF NOT EXISTS idx_fixtures_status ON fixtures(status);
CREATE INDEX IF NOT EXISTS idx_fixtures_api ON fixtures(api_fixture_id);
CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds(fixture_id);
CREATE INDEX IF NOT EXISTS idx_live_matches_active ON live_matches(is_active);
CREATE INDEX IF NOT EXISTS idx_bet_slips_user ON bet_slips(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_standings_league ON standings(league_id);
CREATE INDEX IF NOT EXISTS idx_teams_api ON teams(api_team_id);
CREATE INDEX IF NOT EXISTS idx_leagues_api ON leagues(api_league_id);
