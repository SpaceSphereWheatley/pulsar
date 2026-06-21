"""Capture Python portfolio-response ground truth for a deterministic trade
sequence, so the Worker's portfolio math can be verified cross-implementation.

Drives the real FastAPI app via TestClient with the market caches stubbed to the
same MOCK data the Worker tests seed (nok_rate left at its 10.5 default, which
the Worker also uses), runs a fixed deposit/buy/sell/withdraw sequence, and dumps
the final portfolio response + history.

Output: migration/fixtures/portfolio.json
Run from repo root: python3 migration/generate_portfolio_fixture.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

MOCK_COINS = {
    "bitcoin": {
        "id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
        "image": "https://example.com/btc.png", "current_price": 67_000.0,
        "market_cap": 1_320_000_000_000, "market_cap_rank": 1,
        "total_volume": 34_200_000_000, "price_change_percentage_24h": 2.41,
        "price_change_percentage_7d_in_currency": -1.12,
    },
    "ethereum": {
        "id": "ethereum", "symbol": "eth", "name": "Ethereum",
        "image": "https://example.com/eth.png", "current_price": 3_500.0,
        "market_cap": 420_000_000_000, "market_cap_rank": 2,
        "total_volume": 15_000_000_000, "price_change_percentage_24h": 1.5,
        "price_change_percentage_7d_in_currency": 2.3,
    },
}

# The fixed sequence both implementations execute (method, path, json-body).
SEQUENCE = [
    ("deposit", {"amount": 10_000}),
    ("buy", {"coin_id": "bitcoin", "usd_amount": 6_700}),
    ("buy", {"coin_id": "ethereum", "usd_amount": 1_750}),
    ("buy", {"coin_id": "bitcoin", "usd_amount": 1_340}),   # averages in
    ("sell", {"coin_id": "bitcoin", "usd_amount": 3_350}),
    ("withdraw", {"amount": 500}),
]


def main() -> None:
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    import data
    import main
    import portfolio
    import portfolio_history
    import users
    import watchlist
    from fastapi.testclient import TestClient
    from scheduler import scheduler

    users.USERS_FILE = tmp / "users.json"
    portfolio._PORTFOLIO_DIR = tmp
    portfolio_history._HISTORY_DIR = tmp
    watchlist._WATCHLIST_DIR = tmp

    data._coins_cache = MOCK_COINS.copy()
    data._coins_cache_ts = time.time()
    data._ohlc_cache = {}
    data._nok_rate = 10.5
    data._nok_rate_ts = time.time()

    with (
        patch.object(main, "init_data", return_value=None),
        patch.object(main, "refresh_feargreed", new=AsyncMock()),
        patch.object(main, "refresh_news", new=AsyncMock()),
        patch.object(main, "refresh_nok_rate", new=AsyncMock()),
        patch.object(data, "refresh_ohlc", MagicMock()),
        patch.object(data, "refresh_coins", MagicMock()),
        patch.object(scheduler, "add_job", MagicMock()),
        patch.object(scheduler, "start", MagicMock()),
        patch.object(scheduler, "shutdown", MagicMock()),
    ):
        with TestClient(main.app) as c:
            tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin"}).json()[
                "access_token"
            ]
            hdr = {"Authorization": f"Bearer {tok}"}
            steps = []
            for action, body in SEQUENCE:
                r = c.post(f"/api/portfolio/{action}", json=body, headers=hdr)
                steps.append({"action": action, "body": body, "status": r.status_code, "response": r.json()})
            final = c.get("/api/portfolio", headers=hdr).json()

    out = {
        "coins_cache": MOCK_COINS,
        "nok_rate": 10.5,
        "sequence": SEQUENCE,
        "steps": steps,
        "final": final,
    }
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    (FIXTURE_DIR / "portfolio.json").write_text(json.dumps(out, indent=2, allow_nan=False))
    print("Wrote portfolio fixture. Final:")
    f = out["final"]
    print(f"  cash={f['cash']} total_value={f['total_value']} pnl={f['total_pnl']} pnl_pct={f['total_pnl_pct']}")
    for h in f["holdings"]:
        print(f"  {h['coin_id']}: amount={h['amount']} avg={h['avg_buy_price']} value={h['value']} pnl={h['pnl']}")


if __name__ == "__main__":
    main()
