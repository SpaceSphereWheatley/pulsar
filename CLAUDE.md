# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PULSAR is a locally-hosted cryptocurrency dashboard with live market data, technical analysis, ML-based scoring, and a virtual investment portfolio. It tracks the top 10 coins by market cap from CoinGecko.

## Commands

```bash
# Run the server (development)
cd server && uvicorn main:app --reload --port 8000

# Or use the start script (port 8001, macOS caffeinate wrapper)
./start.sh

# Run all tests
pytest

# Run a single test file
pytest server/tests/test_indicators.py

# Run a single test by name
pytest server/tests/test_api.py::test_coins_endpoint

# Lint
ruff check server/
```

Install deps: `pip install -r requirements.txt` (runtime) and `pip install -r requirements-dev.txt` (test/lint).

## Environment variables

Copy `.env.example` to `.env` in the repo root before running. Key vars:

| Variable | Default | Notes |
|---|---|---|
| `PULSAR_SECRET_KEY` | `pulsar-dev-secret-change-before-deploying` | Change for any non-local deployment |
| `PULSAR_ADMIN_USERNAME` | `admin` | Seeded on first startup |
| `PULSAR_ADMIN_PASSWORD` | `admin` | Seeded on first startup |
| `PULSAR_TOKEN_EXPIRE_MINUTES` | `60` | JWT lifetime |
| `COINGECKO_API_KEY` | _(none)_ | **Required** for OHLC, signals, backtesting, and ML. Get a free Demo key at coingecko.com/en/api/pricing |
| `COINGECKO_PRO_API_KEY` | _(none)_ | Use instead for paid CoinGecko Pro plans |

## Repository layout

```
pulsar/
├── frontend/
│   └── index.html          # Single-file SPA (vanilla JS + Tailwind CSS)
├── server/
│   ├── main.py             # FastAPI app, all routes, lifespan, composite scoring
│   ├── auth.py             # JWT creation/decoding, bcrypt password helpers
│   ├── users.py            # JSON-backed user storage, admin seeding
│   ├── data.py             # CoinGecko fetching, in-memory caches
│   ├── indicators.py       # RSI-14, MACD(12,26,9), Bollinger Bands(20,2σ)
│   ├── ml.py               # Per-coin Ridge regression scoring
│   ├── portfolio.py        # Virtual portfolio CRUD (JSON files)
│   ├── portfolio_history.py# Daily portfolio value snapshots
│   ├── watchlist.py        # Per-user coin watchlists (JSON files)
│   ├── backtest.py         # Historical signal backtesting engine
│   ├── recommendation.py   # Plain-language buy/sell/hold recommendations
│   ├── scheduler.py        # APScheduler setup (jobs live in main.py lifespan)
│   └── tests/
│       ├── conftest.py     # Fixtures: client, auth_headers, mock market data
│       ├── test_api.py     # Route integration tests (~44 tests)
│       ├── test_auth.py    # Login, user management, admin enforcement
│       ├── test_indicators.py   # RSI, MACD, BB, signal scoring
│       ├── test_backtest.py     # Backtest engine structure/stats
│       ├── test_ml.py           # ML score caching, dataset building, training
│       ├── test_portfolio.py    # Portfolio save/load/reset, isolation
│       ├── test_portfolio_history.py # Snapshot upsert, 365-day retention
│       ├── test_recommendation.py    # Label functions, buy/sell/hold logic
│       └── test_watchlist.py    # Add/remove, idempotency
├── .env.example
├── pyproject.toml          # pytest config (testpaths, pythonpath, asyncio_mode) + ruff
├── requirements.txt
└── requirements-dev.txt
```

## Architecture

### Data flow

All market data lives in **module-level in-memory caches** inside `server/data.py`. On startup (`lifespan` in `main.py`), `init_data()` performs a blocking fetch of coins + OHLC, then APScheduler jobs keep caches warm:

| Cache | Refresh interval | Module |
|---|---|---|
| Top-10 coins | every 60 s | `data.refresh_coins()` |
| OHLC candles (14-day) | every 6 h | `data.refresh_all_ohlc()` |
| Fear & Greed index | every 1 h | `data.refresh_feargreed()` |
| ML scores | every 6 h | `ml.refresh_ml_scores()` |
| News | every 30 min | `data.refresh_news()` |

Routes read from these caches directly — they never call external APIs inline (except `feargreed`/`news`, which fall back to a refresh if the cache is cold).

### Signal pipeline

`GET /api/coins` and `/api/signals` both compute per-coin signals inline:

1. `data.get_ohlc(coin_id)` → raw 14-day OHLC candles `[ts_ms, open, high, low, close]`
2. `indicators.compute_indicators(ohlc)` → RSI-14, MACD(12,26,9), Bollinger Bands(20,2σ). Returns `None` if fewer than 30 candles.
3. `indicators.compute_signal(indics, change_7d)` → weighted score: RSI 35% | MACD 35% | BB 20% | 7-day trend 10% → signal string (`strong_buy` / `buy` / `neutral` / `caution` / `sell`)
4. `ml.get_ml_score(coin_id)` → Ridge regression score (0–100, trained per-coin on OHLC history, requires 40+ candles)
5. `_composite(signal_score, ml_score)` in `main.py` → 60% technical / 40% ML blended score

Signal thresholds: ≥75 → `strong_buy`, ≥60 → `buy`, ≥40 → `neutral`, ≥25 → `caution`, <25 → `sell`.

### Auth

JWT Bearer tokens via `python-jose`. `auth.py` handles token creation/decoding (HS256, configurable expiry). `users.py` stores bcrypt-hashed passwords in `server/users.json` (created at runtime). The admin account is seeded on startup via `seed_admin()`. Non-admin routes use `get_current_user`; admin-only routes use `require_admin`.

User record shape:
```json
{ "hashed_password": "...", "is_admin": false, "created_at": "ISO8601", "created_by": "admin" }
```

### Portfolio persistence

Portfolio files live inside `server/` (gitignored). File naming:
- `portfolio_{username}.json` — default portfolio
- `portfolio_{username}_{name}.json` — named portfolios

`portfolio.py` manages CRUD; `portfolio_history.py` appends daily snapshots (max 365, keyed by date). Initial cash is **$10,000**. Portfolio names must match `[a-z0-9_-]{1,32}`.

Portfolio schema:
```json
{
  "cash": 10000.0,
  "initial_cash": 10000.0,
  "holdings": { "bitcoin": { "amount": 0.05, "avg_buy_price": 50000.0 } },
  "transactions": [{ "id": "txn_0001", "type": "buy", "coin_id": "bitcoin",
                     "amount": 0.05, "price": 50000.0, "total": 2500.0, "timestamp": "..." }]
}
```

History snapshot schema:
```json
{ "date": "2024-05-17", "total_value": 10500.0, "cash": 5000.0, "pnl_pct": 5.0 }
```

### Recommendation engine

`recommendation.py` evaluates held coins and unowned coins with composite score ≥70 against portfolio state. Limits any single position to 20% of total portfolio value (`_MAX_POSITION_PCT`). Minimum trade size is $10 (`_MIN_TRADE_USD`). Returns plain-English summary + per-coin `action` / `plain` / `detail` / `suggested_usd`.

### Backtesting

`backtest.py` walks historical OHLC (min 35 candles), computes signal at each point, measures actual forward return over the next 7 days, and aggregates win rate + average return broken down by signal type.

### Frontend

`frontend/index.html` is a single-file SPA (vanilla JS, Tailwind CSS, TradingView Lightweight Charts). FastAPI mounts it at `/` via `StaticFiles` after all `/api/*` routes are registered, so API routes always take precedence. The app polls for fresh market data, renders sparklines, and shows a portfolio history chart.

## API routes

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Username/password → JWT access token |
| GET | `/api/auth/users` | admin | List all users |
| POST | `/api/auth/users` | admin | Create new user |
| DELETE | `/api/auth/users/{username}` | admin | Delete user |

### Market data
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/coins` | — | Top 10 coins with price, indicators, signals |
| GET | `/api/market` | — | Market cap, volume, dominance, advancing/declining counts |
| GET | `/api/feargreed` | — | Fear & Greed index value, 7-day history, interpretation |
| GET | `/api/history/{coin_id}` | — | 14-day OHLC candles |
| GET | `/api/signals` | — | All coins with signal + ML + composite scores |
| GET | `/api/news` | — | Latest crypto news (~20 items) |
| GET | `/api/backtest/{coin_id}` | — | Historical signal backtest results |

### Watchlist (authenticated)
| Method | Path | Description |
|---|---|---|
| GET | `/api/watchlist` | Get user's watchlist |
| POST | `/api/watchlist/{coin_id}` | Add coin |
| DELETE | `/api/watchlist/{coin_id}` | Remove coin |

### Portfolio (authenticated)
| Method | Path | Query param | Description |
|---|---|---|---|
| GET | `/api/portfolios` | — | List portfolio names |
| POST | `/api/portfolios` | — | Create named portfolio |
| DELETE | `/api/portfolios/{name}` | — | Delete named portfolio |
| GET | `/api/portfolio` | `portfolio=default` | Portfolio details with P&L |
| GET | `/api/portfolio/history` | `portfolio=default` | Daily snapshots |
| POST | `/api/portfolio/buy` | — | Buy a coin |
| POST | `/api/portfolio/sell` | — | Sell a coin |
| POST | `/api/portfolio/reset` | `portfolio=default` | Reset to $10k cash |
| GET | `/api/portfolio/recommendation` | `portfolio=default` | Buy/sell/hold recommendations |

## Testing

Tests use FastAPI's `TestClient`. The `client` fixture in `conftest.py`:
- Patches all external CoinGecko/alternative.me API calls with `MOCK_COINS`, `MOCK_OHLC`, `MOCK_FEARGREED`, `MOCK_NEWS`
- Redirects file I/O (users, portfolios, watchlists) to `tmp_path` for full isolation
- Seeds the admin user automatically

The `auth_headers` fixture logs in as the seeded admin and returns `{"Authorization": "Bearer <token>"}`.

`pyproject.toml` sets `pythonpath = ["server"]` so imports work without `sys.path` manipulation.

Tests are fully isolated and require no network access. Run `pytest -v` for verbose output or `pytest --cov=server` for coverage.

## Key conventions

- **No database** — all persistence is JSON files in `server/`. Never add a database dependency without explicit instruction.
- **In-memory caches with TTL** — data.py caches are module-level dicts. Never call CoinGecko inline from a route handler.
- **ML scores are optional** — `ml.get_ml_score()` returns `None` if a coin has insufficient history. All callers handle `None`.
- **Indicator computation requires 30+ candles** — `compute_indicators()` returns `None` for sparse data. Signal pipeline must guard against `None` indicators.
- **File paths use `_path()` helpers** — portfolio.py, watchlist.py, and portfolio_history.py each have a `_path()` function. Tests patch these via `tmp_path` in conftest.
- **Admin cannot be deleted** — `users.delete_user()` refuses to delete the admin account.
- **Portfolio "default" cannot be deleted** — `portfolio.delete_portfolio()` raises if `name == "default"`.
- **Ruff line length is 100** — configured in `pyproject.toml`.
