# PULSAR — Project Documentation

> A live cryptocurrency dashboard with technical analysis, ML-based scoring, and a virtual investment portfolio.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Data Pipeline](#4-data-pipeline)
5. [API Specification](#5-api-specification)
6. [Technical Indicators](#6-technical-indicators)
7. [ML Approach](#7-ml-approach)
8. [Virtual Portfolio Spec](#8-virtual-portfolio-spec)
9. [Frontend Spec](#9-frontend-spec)
10. [Build Phases](#10-build-phases)
11. [Setup Instructions](#11-setup-instructions)
12. [Known Limitations & Disclaimers](#12-known-limitations--disclaimers)

---

## 1. Project Overview

**Goal:** A locally-hosted cryptocurrency dashboard that shows live market data for the top 10 coins, computes technical analysis signals, provides an ML-based investment score, and lets the user simulate investments with a virtual portfolio.

**What it is not:** A financial advisor. All signals, scores, and predictions are for educational and entertainment purposes only.

**Core features:**
- Live top 10 coin data (price, volume, market cap, 24h/7d change)
- Fear & Greed index with historical context, plain-language interpretation, and overall market verdict
- Technical indicators: RSI, MACD, Bollinger Bands
- Overall market score: a single 0–100 score summarising current market conditions with a plain-language verdict
- Per-coin composite score: combines rule-based signal + ML score into a single Buy / Hold / Sell verdict
- ML-based investment score per coin (deferred — see Section 7)
- Virtual portfolio: buy/sell at live prices, track P&L, persist across sessions
- Auto-refresh every 60 seconds

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                   BROWSER (frontend)                 │
│                                                      │
│   index.html — single file, vanilla JS              │
│   Polls localhost:8000 every 60 seconds             │
│   Displays: market data, indicators, signals,       │
│             portfolio, charts                        │
└───────────────────┬─────────────────────────────────┘
                    │ HTTP (REST)
                    │ localhost:8000
┌───────────────────▼─────────────────────────────────┐
│               PYTHON SERVER (FastAPI)                │
│                                                      │
│   main.py          — FastAPI app, routes            │
│   data.py          — CoinGecko fetching & caching   │
│   indicators.py    — RSI, MACD, Bollinger Bands     │
│   ml.py            — Model training & prediction    │
│   portfolio.py     — Portfolio logic & persistence  │
│   scheduler.py     — Background refresh tasks       │
└───────────────────┬─────────────────────────────────┘
                    │ HTTPS
┌───────────────────▼─────────────────────────────────┐
│              EXTERNAL APIs                           │
│                                                      │
│   CoinGecko Public API  — market data, OHLC history │
│   Alternative.me API    — Fear & Greed index        │
└─────────────────────────────────────────────────────┘

Persistence:
   portfolio.json   — saved to disk on server
   cache.json       — optional: cached API responses
```

---

## 3. Tech Stack

### Backend

| Library | Version | Purpose |
|---|---|---|
| `fastapi` | latest | REST API framework |
| `uvicorn` | latest | ASGI server to run FastAPI |
| `pycoingecko` | latest | CoinGecko API wrapper |
| `pandas` | latest | Data manipulation for OHLC series |
| `scikit-learn` | latest | Per-coin Ridge regression ML score |
| `apscheduler` | latest | Background data refresh scheduler |
| `httpx` | latest | Async HTTP for Fear & Greed API |

### Frontend

| Technology | Purpose |
|---|---|
| Vanilla HTML/CSS/JS | Single file, no build step |
| Chart.js (CDN) | Price charts, portfolio performance |
| Google Fonts (CDN) | Typography |

### File Structure

```
pulsar/
├── server/
│   ├── main.py           # FastAPI app entry point
│   ├── data.py           # Data fetching & caching
│   ├── indicators.py     # Technical indicator computations
│   ├── ml.py             # ML model (Phase 4)
│   ├── portfolio.py      # Portfolio logic
│   ├── scheduler.py      # Background refresh
│   └── portfolio.json    # Persisted portfolio data (auto-created)
├── frontend/
│   └── index.html        # Entire frontend
├── requirements.txt
└── README.md
```

---

## 4. Data Pipeline

### Market Data (CoinGecko)

1. On server startup, fetch top 10 coins by market cap
2. Cache response in memory with a timestamp
3. On each `/api/coins` request: return cache if < 60s old, else re-fetch
4. Background scheduler re-fetches every 60 seconds regardless

**Fields fetched per coin:**
- `id`, `symbol`, `name`, `image`
- `current_price`
- `market_cap`, `market_cap_rank`
- `total_volume`
- `price_change_percentage_24h`
- `price_change_percentage_7d_in_currency`

### Historical OHLC Data (CoinGecko)

- Fetched once per coin on startup, then refreshed every 6 hours
- 14 days of OHLC candles per coin (~4-hour granularity from CoinGecko)
- Used for: RSI, MACD, Bollinger Bands, ML training
- Cached in memory (and optionally to `cache.json`)

### Fear & Greed Index (Alternative.me)

- Endpoint: `https://api.alternative.me/fng/?limit=7`
- Returns last 7 days of values
- Refreshed every 60 minutes
- Fields used: `value`, `value_classification`, timestamps for yesterday + last week

---

## 5. API Specification

Base URL: `http://localhost:8000`

All endpoints return JSON. CORS is enabled for `localhost` (any port) so the frontend HTML file can call the server from the filesystem or a local server.

---

### `GET /api/coins`

Returns live data for the top 10 coins including indicators and signals.

**Response:**
```json
{
  "updated_at": "2025-05-15T09:32:00Z",
  "coins": [
    {
      "id": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "image": "https://...",
      "price": 67420.12,
      "market_cap": 1320000000000,
      "market_cap_rank": 1,
      "volume_24h": 34200000000,
      "change_24h": 2.41,
      "change_7d": -1.12,
      "indicators": {
        "rsi": 58.4,
        "macd": 120.5,
        "macd_signal": 98.2,
        "macd_histogram": 22.3,
        "bb_upper": 70000,
        "bb_lower": 62000,
        "bb_position": 0.68
      },
      "signal": "neutral",
      "signal_reasons": ["RSI in neutral zone", "Price near BB midpoint"]
    }
  ]
}
```

**Signal values:** `"strong_buy"` | `"buy"` | `"neutral"` | `"caution"` | `"sell"`

---

### `GET /api/market`

Returns aggregate market statistics.

**Response:**
```json
{
  "total_market_cap": 2410000000000,
  "total_volume_24h": 98000000000,
  "btc_dominance": 54.2,
  "eth_dominance": 17.8,
  "avg_change_24h": 1.3,
  "advancing": 7,
  "declining": 3
}
```

---

### `GET /api/feargreed`

Returns Fear & Greed index with 7-day history, plain-language interpretation, and overall market score.

**Response:**
```json
{
  "value": 72,
  "classification": "Greed",
  "yesterday": 68,
  "last_week": 55,
  "last_month": 38,
  "trend": 4,
  "history": [
    { "date": "2025-05-15", "value": 72, "classification": "Greed" }
  ],
  "interpretation": "The market is in greed territory and sentiment has risen sharply over the past month. Historically, elevated greed can precede corrections. Consider sizing new positions carefully.",
  "market_score": {
    "score": 41,
    "verdict": "caution",
    "verdict_label": "Cautious",
    "reasons": [
      "Fear & Greed elevated at 72 (Greed)",
      "BTC dominance declining — altcoin risk increasing",
      "Sentiment rising faster than price — possible overextension"
    ]
  }
}
```

**Market score verdict values:** `"buy"` | `"neutral"` | `"caution"` | `"sell"`

**Market score inputs and weights:**

| Input | Weight | Notes |
|---|---|---|
| Fear & Greed (inverted at extremes) | 40% | High greed pulls score down |
| Advancing / declining ratio | 25% | 7/10 advancing = positive |
| BTC dominance 7d trend | 20% | Rising dominance = defensive market |
| Avg 24h change across top 10 | 15% | Broad momentum signal |

---

### `GET /api/history/{coin_id}`

Returns 14-day OHLC history for a single coin.

**Parameters:** `coin_id` — CoinGecko coin ID (e.g. `bitcoin`)

**Response:**
```json
{
  "coin_id": "bitcoin",
  "days": 14,
  "data": [
    { "date": "2025-02-14", "open": 52000, "high": 53400, "low": 51200, "close": 52800, "volume": 28000000000 }
  ]
}
```

---

### `GET /api/signals`

Returns computed signals, ML scores, and composite coin scores for all top 10 coins.

**Response:**
```json
{
  "updated_at": "2025-05-15T09:32:00Z",
  "signals": [
    {
      "coin_id": "bitcoin",
      "symbol": "btc",
      "signal": "buy",
      "signal_score": 72,
      "ml_score": null,
      "composite_score": 72,
      "composite_verdict": "buy",
      "composite_label": "Buy",
      "reasons": ["RSI recovering from oversold", "MACD bullish crossover", "Price bouncing off BB lower band"]
    }
  ]
}
```

`ml_score` is `null` until Phase 4 is implemented. When `ml_score` is null, `composite_score` equals `signal_score`. Once Phase 4 is live, `composite_score` is a weighted blend:

| Input | Weight |
|---|---|
| Signal score (rule-based) | 60% |
| ML score | 40% |

**Composite verdict values:** `"buy"` | `"hold"` | `"sell"`

Score → verdict mapping:
- 60–100 → `buy`
- 40–59 → `hold`
- 0–39 → `sell`

---

### `GET /api/portfolio`

Returns the current virtual portfolio state.

**Response:**
```json
{
  "portfolio_name": "default",
  "cash": 7240.50,
  "cash_nok": 79645.50,
  "total_deposited": 10000,
  "total_withdrawn": 0,
  "net_invested": 10000,
  "holdings": [
    {
      "coin_id": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "image": "https://...",
      "amount": 0.034,
      "avg_buy_price": 65000,
      "current_price": 67420,
      "value": 2292.28,
      "value_nok": 25215.08,
      "pnl": 82.28,
      "pnl_nok": 905.08,
      "pnl_pct": 3.73
    }
  ],
  "total_value": 9532.78,
  "total_value_nok": 104860.58,
  "total_pnl": -467.22,
  "total_pnl_nok": -5139.42,
  "total_pnl_pct": -4.67,
  "nok_rate": 11.0,
  "transactions": [
    {
      "id": "txn_001",
      "type": "buy",
      "coin_id": "bitcoin",
      "symbol": "btc",
      "amount": 0.034,
      "price": 65000,
      "total": 2210,
      "timestamp": "2025-05-14T14:22:00Z"
    }
  ]
}
```

Portfolios start empty (cash $0); the user funds them via `POST /api/portfolio/deposit` and `POST /api/portfolio/withdraw`. P&L is measured against `net_invested = total_deposited − total_withdrawn`.

---

### `POST /api/portfolio/buy`

Buy a coin at the current live price.

**Request body:**
```json
{
  "coin_id": "bitcoin",
  "usd_amount": 500
}
```

**Response:** Updated portfolio state (same shape as `GET /api/portfolio`)

**Rules:**
- Cannot spend more than available cash
- Minimum trade: $1
- Price used is the server's latest cached price

---

### `POST /api/portfolio/sell`

Sell a coin at the current live price.

**Request body:**
```json
{
  "coin_id": "bitcoin",
  "usd_amount": 250
}
```

**Response:** Updated portfolio state

**Rules:**
- Cannot sell more than current holding value
- Minimum trade: $1

---

### `POST /api/portfolio/reset`

Reset portfolio to an empty $0 state, clearing all holdings, deposits, and transaction history.

**Response:** Fresh portfolio state

---

## 6. Technical Indicators

All indicators are hand-rolled in `indicators.py` (no third-party TA library) on the 14-day OHLC series.

### RSI (Relative Strength Index)
- Period: 14 days
- Interpretation used in signals:
  - RSI < 30 → Oversold (bullish signal)
  - RSI > 70 → Overbought (bearish signal)
  - 30–70 → Neutral

### MACD (Moving Average Convergence Divergence)
- Fast: 12, Slow: 26, Signal: 9
- Interpretation:
  - MACD crosses above signal line → Bullish
  - MACD crosses below signal line → Bearish
  - Histogram direction indicates momentum strength

### Bollinger Bands
- Period: 20, Std Dev: 2
- `bb_position`: where current price sits between lower (0.0) and upper (1.0) band
- Interpretation:
  - `bb_position` < 0.2 → Near lower band (potential bounce)
  - `bb_position` > 0.8 → Near upper band (potential resistance)

### Signal Scoring

Each coin gets a composite signal score (0–100) based on weighted indicator inputs:

| Indicator | Weight |
|---|---|
| RSI | 35% |
| MACD crossover | 35% |
| Bollinger Band position | 20% |
| 7d price trend | 10% |

Score → Signal mapping:
- 75–100 → `strong_buy`
- 60–74 → `buy`
- 40–59 → `neutral`
- 25–39 → `caution`
- 0–24 → `sell`

---

## 7. ML Approach

> **Status: Deferred to Phase 4.** This section will be updated once the indicator pipeline is validated.

**Candidate approaches (to be decided in Phase 4):**

**Option A — Linear Regression**
- Features: RSI, MACD histogram, BB position, 7d change, volume change
- Target: % price change in next 7 days
- Pros: Fast, interpretable, stable
- Cons: Assumes linear relationships

**Option B — LSTM Neural Network**
- Features: 30-day sequence of OHLC + volume
- Target: Direction (up/down) in next 3 days
- Pros: Captures temporal patterns
- Cons: Needs more data, slower, harder to interpret

**Honest expectation:** Crypto price prediction is notoriously difficult. The ML score should be treated as one signal among many, not a forecast. It will be labeled clearly in the UI as experimental.

---

## 8. Virtual Portfolio Spec

### Starting State
- Cash: $0 USD (fund via deposit)
- Holdings: empty
- Transactions: empty
- Tracked totals: `total_deposited` = 0, `total_withdrawn` = 0

### Persistence
- Saved to `server/portfolio.json` on every buy/sell/reset
- Loaded from file on server startup
- If file does not exist, a fresh portfolio is created

### Portfolio Data Model (`portfolio.json`)
```json
{
  "cash": 0.0,
  "total_deposited": 0.0,
  "total_withdrawn": 0.0,
  "holdings": {},
  "transactions": []
}
```

`holdings` is a dict keyed by `coin_id`:
```json
{
  "bitcoin": {
    "amount": 0.034,
    "avg_buy_price": 65000
  }
}
```

### Buy Logic
1. Validate `usd_amount` <= available cash and >= $1
2. Look up current price from cache
3. Calculate coin amount = `usd_amount / current_price`
4. Update holding: recalculate `avg_buy_price` as weighted average
5. Deduct cash
6. Append transaction record
7. Save to disk

### Sell Logic
1. Validate holding exists and `usd_amount` <= current holding value
2. Calculate coin amount to sell = `usd_amount / current_price`
3. Reduce holding amount (remove entry if fully sold)
4. Add cash
5. Append transaction record
6. Save to disk

### P&L Calculation (computed on read, not stored)
- Per holding: `(current_price - avg_buy_price) / avg_buy_price * 100`
- Total: `(total_value - net_invested) / net_invested * 100`, where
  `net_invested = total_deposited - total_withdrawn`

---

## 9. Frontend Spec

Single file: `frontend/index.html`

### Design Direction

Mobile-first. Maximum width 480px, centered. No tables — coin data is presented as individual cards. Scales up gracefully to desktop via CSS grid. Inspired by modern fintech apps (Robinhood, Coinbase).

- **Typography:** Plus Jakarta Sans (body), Syne (display numbers and logo)
- **Colors:** Dark background (#0d0f14), vibrant accents (violet, cyan, green, red, amber)
- **Layout:** Single scrollable column on mobile; sidebar + content grid on desktop
- **Navigation:** Tab strip on mobile, left sidebar on desktop; bottom nav bar on mobile

### Mobile Layout (≤480px)

```
┌────────────────────────┐
│ NAV — logo, live, ?    │
├────────────────────────┤
│ TAB STRIP              │
│ Market | Portfolio |   │
│ Signals | F&G          │
├────────────────────────┤
│ PORTFOLIO HERO CARD    │
│ total value | P&L      │
│ cash | invested | today│
├────────────────────────┤
│ MARKET STATS (2-col)   │
│ Mkt Cap  │ Volume      │
│ BTC Dom  │ Advancing   │
├────────────────────────┤
│ FEAR & GREED CARD      │
│ score | word | gauge   │
│ interpretation text    │
│ ─────────────────────  │
│ MARKET SCORE           │
│ score | verdict        │
│ reason bullets         │
├────────────────────────┤
│ COIN CARDS (×10)       │
│ ┌──────────────────┐   │
│ │ icon  name  price│   │
│ │       sym   24h  │   │
│ │ RSI │ MACD │ 7D  │   │
│ │ signal    ML+comp│   │
│ └──────────────────┘   │
├────────────────────────┤
│ MARKET DOMINANCE BAR   │
├────────────────────────┤
│ MOVERS (2-col)         │
│ Gainers  │ Losers      │
├────────────────────────┤
│ BOTTOM NAV BAR         │
└────────────────────────┘
```

### Desktop Layout (≥600px)

```
┌──────────────────────────────────────┐
│ NAV (full width)                     │
├──────────┬───────────────────────────┤
│ LEFT     │ MAIN CONTENT              │
│ SIDEBAR  │                           │
│          │ Portfolio hero            │
│ Tab nav  │ Market stats (4-col)      │
│          │ F&G card + market score   │
│          │ Coin cards (2-col grid)   │
│          │ Dominance + Movers        │
└──────────┴───────────────────────────┘
```

### Fear & Greed Card — New Elements

**Interpretation text:** A 1–2 sentence plain-language summary of what the current index value means in context, generated server-side based on value + recent trend.

**Market Score block** (displayed below the gauge inside the same card):
- Large score number (0–100)
- Verdict badge: Buy / Neutral / Caution / Sell with color coding
- 2–3 bullet reasons in plain language
- Disclaimer: "This reflects current market conditions, not a prediction."

### Coin Card — Composite Score

Each coin card shows a **composite score** in the bottom-right corner alongside the signal badge:
- Displayed as a colored number badge (e.g. `74`)
- Color: green (≥60), amber (40–59), red (<40)
- Label beneath: `Buy` / `Hold` / `Sell`
- Tooltip on tap/hover: lists the signal reasons

### Refresh Logic
- On page load: fetch all endpoints in parallel
- Every 60 seconds: re-fetch `/api/coins`, `/api/market`, `/api/signals`
- Every 60 minutes: re-fetch `/api/feargreed`
- Countdown timer visible in nav bar
- Portfolio re-fetched after every buy/sell action

### Portfolio UI
- Hero card always visible at top of dashboard
- Holdings list: coin, amount, avg buy price, current value, P&L
- Buy/sell: coin selector + USD amount input + Buy/Sell buttons
- Reset button with confirmation prompt
- Transaction history: scrollable log, newest first

---

## 10. Build Phases

### Phase 1 — Server Foundation
**Goal:** Running FastAPI server with live CoinGecko data

Tasks:
- Set up project structure and `requirements.txt`
- Implement `data.py`: fetch top 10 coins, cache in memory
- Implement background scheduler (60s refresh)
- Implement `GET /api/coins` and `GET /api/market`
- Enable CORS
- Test with curl / browser

**Done when:** `curl localhost:8000/api/coins` returns live data.

---

### Phase 2 — Technical Indicators & Scoring
**Goal:** RSI, MACD, Bollinger Bands computed and served; market score and composite coin score implemented

Tasks:
- Implement `GET /api/history/{coin_id}`
- Implement `indicators.py` with hand-rolled RSI/MACD/Bollinger math
- Add indicator fields to `/api/coins` response
- Implement per-coin signal scoring logic
- Implement composite coin score (signal score only until Phase 4 adds ML)
- Implement overall market score in `GET /api/feargreed`
- Implement plain-language interpretation logic for Fear & Greed
- Implement `GET /api/signals`

**Done when:** `/api/signals` returns composite scores and `/api/feargreed` returns a market score with interpretation text.

---

### Phase 3 — Frontend Dashboard
**Goal:** Full mobile-first live dashboard in the browser

Tasks:
- Build `index.html` with mobile-first card layout (no tables)
- Connect all API endpoints
- Implement auto-refresh with countdown
- Implement Fear & Greed card with gauge, interpretation text, and market score block
- Implement market dominance bar
- Implement coin cards with RSI/MACD/7D indicators, signal badge, and composite score
- Implement bottom nav (mobile) and sidebar nav (desktop)
- Implement virtual portfolio hero card and holdings list
- Connect portfolio to `POST /api/portfolio/buy` and `sell`
- Implement help modal with glossary

**Done when:** Dashboard fully functional on mobile and desktop with live data, market score, composite coin scores, and working portfolio.

---

### Phase 4 — ML Scoring
**Goal:** ML-based investment score per coin

Tasks:
- Decide on model approach (Linear Regression vs LSTM)
- Implement `ml.py`: feature engineering, training, prediction
- Add `ml_score` to `/api/signals` response
- Display ML score in frontend table
- Add disclaimer label in UI

**Done when:** Each coin shows an ML score alongside the rule-based signal.

---

### Phase 5 — Polish & Extras
**Goal:** Quality of life improvements

Candidate tasks (to be prioritized):
- Price sparkline charts per coin (7-day mini chart)
- Portfolio performance chart over time
- News feed per coin (if a free API is available)
- Mobile-responsive layout improvements
- Dark/light theme toggle
- Export portfolio history to CSV

---

## 11. Setup Instructions

> To be written in detail during Phase 1. Outline:

**Requirements:**
- Python 3.10+
- pip

**Install:**
```bash
cd pulsar/server
pip install -r requirements.txt
```

**Run:**
```bash
uvicorn main:app --reload --port 8000
```

**Open frontend:**
```
Open frontend/index.html in any browser
```

**requirements.txt:**
```
fastapi
uvicorn[standard]
pycoingecko
pandas
scikit-learn
apscheduler
httpx
python-jose[cryptography]
passlib[bcrypt]
bcrypt==4.0.1
python-dotenv
```

---

## 12. Known Limitations & Disclaimers

- **Not financial advice.** All signals, scores, and predictions are for educational and entertainment purposes only.
- **CoinGecko rate limits.** The free public API allows ~30 calls/minute. The caching layer is designed to stay well within this limit.
- **RSI/MACD accuracy.** Indicators are computed on daily candles only. Intraday movements are not captured.
- **ML predictions.** Cryptocurrency prices are highly unpredictable. The per-coin Ridge regression is trained on a short OHLC window and should be treated as experimental. Past performance does not predict future results.
- **Virtual portfolio prices.** Buy/sell prices are taken from the server's cached data, which may be up to 60 seconds old.
- **No real money.** The virtual portfolio is entirely simulated. No real transactions are made.
