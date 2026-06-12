import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

MOCK_NEWS = [
    {
        "title": "Bitcoin reaches new milestone",
        "url": "https://example.com/btc-news",
        "thumb": "",
        "description": "BTC surges past key resistance.",
        "author": "CryptoDesk",
        "published_at": "2024-05-01T12:00:00Z",
    },
    {
        "title": "Ethereum upgrade scheduled",
        "url": "https://example.com/eth-news",
        "thumb": "",
        "description": "Devs confirm the next hard fork date.",
        "author": "CryptoDesk",
        "published_at": "2024-05-01T10:00:00Z",
    },
]

MOCK_COINS = {
    "bitcoin": {
        "id": "bitcoin",
        "symbol": "btc",
        "name": "Bitcoin",
        "image": "https://example.com/btc.png",
        "current_price": 67_000.0,
        "market_cap": 1_320_000_000_000,
        "market_cap_rank": 1,
        "total_volume": 34_200_000_000,
        "price_change_percentage_24h": 2.41,
        "price_change_percentage_7d_in_currency": -1.12,
    },
    "ethereum": {
        "id": "ethereum",
        "symbol": "eth",
        "name": "Ethereum",
        "image": "https://example.com/eth.png",
        "current_price": 3_500.0,
        "market_cap": 420_000_000_000,
        "market_cap_rank": 2,
        "total_volume": 15_000_000_000,
        "price_change_percentage_24h": 1.5,
        "price_change_percentage_7d_in_currency": 2.3,
    },
}

# 90 candles with cyclic variation so RSI/MACD/BB produce valid (non-NaN) values.
# Close oscillates ±900 around 65 000 on a 7-bar cycle.
MOCK_OHLC = [
    [
        1_715_000_000_000 - i * 86_400_000,
        65_000.0 + (i % 5) * 200,
        67_000.0 + (i % 5) * 200 + 500,
        63_000.0 + (i % 5) * 200 - 500,
        65_000.0 + (i % 7 - 3) * 300,
    ]
    for i in range(90)
]

MOCK_FEARGREED = {
    "data": [
        {"value": "72", "value_classification": "Greed", "timestamp": "1715000000"},
        {"value": "68", "value_classification": "Greed", "timestamp": "1714913600"},
        {"value": "65", "value_classification": "Greed", "timestamp": "1714827200"},
        {"value": "60", "value_classification": "Greed", "timestamp": "1714740800"},
        {"value": "58", "value_classification": "Fear", "timestamp": "1714654400"},
        {"value": "55", "value_classification": "Fear", "timestamp": "1714568000"},
        {"value": "55", "value_classification": "Fear", "timestamp": "1714481600"},
    ]
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    import data
    import main
    import portfolio
    import portfolio_history
    import users
    import watchlist
    from fastapi.testclient import TestClient
    from scheduler import scheduler

    # Redirect persistent storage to tmp_path so tests are isolated
    monkeypatch.setattr(users, "USERS_FILE", tmp_path / "users.json")
    monkeypatch.setattr(portfolio, "_PORTFOLIO_DIR", tmp_path)
    monkeypatch.setattr(portfolio_history, "_HISTORY_DIR", tmp_path)
    monkeypatch.setattr(watchlist, "_WATCHLIST_DIR", tmp_path)

    # Pre-populate caches so routes don't call external APIs
    data._coins_cache = MOCK_COINS.copy()
    data._coins_cache_ts = time.time()
    data._feargreed_cache = MOCK_FEARGREED.copy()
    data._feargreed_cache_ts = time.time()
    data._ohlc_cache = {coin_id: {"data": MOCK_OHLC, "ts": time.time()} for coin_id in MOCK_COINS}
    data._news_cache = MOCK_NEWS.copy()
    data._news_cache_ts = time.time()
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
            yield c


@pytest.fixture
def auth_headers(client):
    """Return Bearer auth headers for the seeded admin account."""
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200, f"Login failed: {r.text}"
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def funded_headers(client, auth_headers):
    """Admin auth headers with $10,000 pre-deposited in the default portfolio."""
    client.post("/api/portfolio/deposit", json={"amount": 10_000}, headers=auth_headers)
    return auth_headers
