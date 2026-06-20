# PULSAR

A locally-hosted cryptocurrency dashboard with technical analysis, ML-based scoring, and a virtual investment portfolio.

## Quick start

```bash
cd pulsar/server
pip install -r ../requirements.txt
uvicorn main:app --reload --port 8000
```

Open `frontend/index.html` in any browser, or navigate to `http://localhost:8000/api/coins`.

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
