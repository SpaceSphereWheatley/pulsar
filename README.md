# PULSAR

A locally-hosted cryptocurrency dashboard with technical analysis, ML-based scoring, and a virtual investment portfolio.

## Quick start

Copy `.env.example` to `.env` first (see [Environment variables](#environment-variables) in `CLAUDE.md`).

**With Docker (one command, any OS):**

```bash
docker build -t pulsar .
docker run --rm -p 8000:8000 --env-file .env pulsar
```

**With Make:**

```bash
make install
make run
```

**Plain Python:**

```bash
pip install -r requirements.txt
uvicorn server.main:app --reload --port 8000
```

Then open `http://localhost:8000/` in any browser (the dashboard is served by the API),
or hit `http://localhost:8000/api/coins` directly.

### CORS

Browser origins allowed to call the API come from `PULSAR_CORS_ORIGINS`
(comma-separated). It defaults to `http://localhost:8000,http://localhost:8001`;
add your own origin there if you serve the frontend from elsewhere.

## Project layout

```
pulsar/
├── server/
│   ├── main.py           # FastAPI app & all routes
│   ├── data.py           # CoinGecko fetching & caching
│   ├── indicators.py     # RSI, MACD, BB (Phase 2)
│   ├── ml.py             # ML scoring (Phase 4)
│   ├── portfolio.py      # Virtual portfolio logic
│   └── scheduler.py      # Background refresh jobs
├── frontend/
│   └── index.html        # Dashboard (Phase 3)
├── requirements.txt
└── README.md
```

## Build phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Complete | Server foundation — live CoinGecko data, all API routes |
| 2 | ✅ Complete | Technical indicators (RSI, MACD, BB) & scoring |
| 3 | ✅ Complete | Full frontend dashboard |
| 4 | ✅ Complete | ML-based investment scoring |
| 5 | ✅ Complete | Polish & extras |

See `docs/pulsardocs.md` for the full specification.
