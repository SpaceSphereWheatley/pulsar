-- PULSAR D1 schema — replaces the JSON-file persistence of the FastAPI app.
-- Mirrors the shapes in users.py / portfolio.py / portfolio_history.py /
-- watchlist.py, plus cache tables that replace data.py's in-memory dicts.

-- Users (was users.json). Passwords are PBKDF2 (Web Crypto), not bcrypt.
CREATE TABLE users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  hashed_password TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

-- One row per (user, portfolio name). 'default' is implicit and created lazily.
CREATE TABLE portfolios (
  username TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  cash REAL NOT NULL DEFAULT 0,
  total_deposited REAL NOT NULL DEFAULT 0,
  total_withdrawn REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (username, name)
);

CREATE TABLE holdings (
  username TEXT NOT NULL,
  portfolio_name TEXT NOT NULL DEFAULT 'default',
  coin_id TEXT NOT NULL,
  amount REAL NOT NULL,
  avg_buy_price REAL NOT NULL,
  PRIMARY KEY (username, portfolio_name, coin_id)
);

-- Transactions: buy/sell carry coin_id/amount/price; deposit/withdrawal don't.
-- seq is the per-portfolio ordinal that drives the txn_NNNN id.
CREATE TABLE transactions (
  username TEXT NOT NULL,
  portfolio_name TEXT NOT NULL DEFAULT 'default',
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  coin_id TEXT,
  amount REAL,
  price REAL,
  total REAL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (username, portfolio_name, seq)
);

-- Daily value snapshots (was portfolio_history_*.json), max 365 days enforced in code.
CREATE TABLE portfolio_history (
  username TEXT NOT NULL,
  portfolio_name TEXT NOT NULL DEFAULT 'default',
  date TEXT NOT NULL,
  total_value REAL,
  cash REAL,
  pnl_pct REAL,
  PRIMARY KEY (username, portfolio_name, date)
);

CREATE TABLE watchlist (
  username TEXT NOT NULL,
  coin_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (username, coin_id)
);

-- Market-data caches (replace data.py module-level dicts). JSON in `data`.
CREATE TABLE coins_cache (coin_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE ohlc_cache (coin_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE feargreed_cache (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE news_cache (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE ml_scores (coin_id TEXT PRIMARY KEY, score REAL, quality REAL, updated_at REAL NOT NULL);

-- Scalar key/value store (e.g. nok_rate + its timestamp).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL);

CREATE INDEX idx_holdings_pf ON holdings(username, portfolio_name);
CREATE INDEX idx_txn_pf ON transactions(username, portfolio_name, seq);
CREATE INDEX idx_history_pf ON portfolio_history(username, portfolio_name, date);
CREATE INDEX idx_watchlist_user ON watchlist(username, seq);
