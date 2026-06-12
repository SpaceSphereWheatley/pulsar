import pytest


# ── /api/coins ────────────────────────────────────────────────────────────────


def test_coins_returns_200(client):
    r = client.get("/api/coins")
    assert r.status_code == 200


def test_coins_shape(client):
    body = client.get("/api/coins").json()
    assert "updated_at" in body
    assert "coins" in body
    assert len(body["coins"]) == 2


def test_coins_fields(client):
    coin = client.get("/api/coins").json()["coins"][0]
    for key in (
        "id",
        "symbol",
        "name",
        "price",
        "market_cap",
        "volume_24h",
        "change_24h",
        "change_7d",
        "signal",
        "price_history_7d",
    ):
        assert key in coin


def test_coins_price_history_7d(client):
    coin = client.get("/api/coins").json()["coins"][0]
    hist = coin["price_history_7d"]
    assert isinstance(hist, list)
    assert 1 <= len(hist) <= 7
    assert all(isinstance(p, float) for p in hist)


# ── /api/market ───────────────────────────────────────────────────────────────


def test_market_shape(client):
    body = client.get("/api/market").json()
    for key in (
        "total_market_cap",
        "total_volume_24h",
        "btc_dominance",
        "eth_dominance",
        "avg_change_24h",
        "advancing",
        "declining",
    ):
        assert key in body


def test_market_advancing_count(client):
    body = client.get("/api/market").json()
    # both mock coins have positive 24h change
    assert body["advancing"] == 2
    assert body["declining"] == 0


def test_market_btc_dominance(client):
    body = client.get("/api/market").json()
    assert 0 < body["btc_dominance"] < 100


# ── /api/feargreed ────────────────────────────────────────────────────────────


def test_feargreed_shape(client):
    body = client.get("/api/feargreed").json()
    for key in (
        "value",
        "classification",
        "yesterday",
        "last_week",
        "trend",
        "history",
        "interpretation",
        "market_score",
    ):
        assert key in body


def test_feargreed_values(client):
    body = client.get("/api/feargreed").json()
    assert body["value"] == 72
    assert body["classification"] == "Greed"
    assert body["yesterday"] == 68


def test_feargreed_market_score_shape(client):
    ms = client.get("/api/feargreed").json()["market_score"]
    for key in ("score", "verdict", "verdict_label", "reasons"):
        assert key in ms
    assert 0 <= ms["score"] <= 100


# ── /api/history ──────────────────────────────────────────────────────────────


def test_history_bitcoin(client):
    body = client.get("/api/history/bitcoin").json()
    assert body["coin_id"] == "bitcoin"
    assert len(body["data"]) == 90
    assert {"date", "open", "high", "low", "close"} <= body["data"][0].keys()


def test_history_unknown_coin_returns_404(client):
    assert client.get("/api/history/dogecoin").status_code == 404


# ── /api/signals ──────────────────────────────────────────────────────────────


def test_signals_shape(client):
    body = client.get("/api/signals").json()
    assert "signals" in body
    sig = body["signals"][0]
    for key in (
        "coin_id",
        "symbol",
        "signal",
        "signal_score",
        "ml_score",
        "composite_score",
        "composite_verdict",
        "composite_label",
    ):
        assert key in sig


def test_signals_ml_score_null_until_trained(client):
    # Scheduler is mocked so refresh_ml_scores is never called in tests
    signals = client.get("/api/signals").json()["signals"]
    assert all(s["ml_score"] is None for s in signals)


def test_signals_composite_equals_signal_when_no_ml(client):
    signals = client.get("/api/signals").json()["signals"]
    for s in signals:
        assert s["composite_score"] == pytest.approx(s["signal_score"], abs=0.1)


# ── /api/portfolio ────────────────────────────────────────────────────────────


def test_portfolio_requires_auth(client):
    assert client.get("/api/portfolio").status_code == 401
    assert client.post("/api/portfolio/buy", json={}).status_code == 401
    assert client.post("/api/portfolio/sell", json={}).status_code == 401
    assert client.post("/api/portfolio/reset").status_code == 401


def test_portfolio_initial_state(client, auth_headers):
    body = client.get("/api/portfolio", headers=auth_headers).json()
    assert body["cash"] == 0.0
    assert body["holdings"] == []
    assert body["total_value"] == 0.0
    assert body["total_pnl"] == 0.0


def test_portfolio_buy_deducts_cash(client, funded_headers):
    body = client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    ).json()
    assert body["cash"] == pytest.approx(9_000.0)
    assert len(body["holdings"]) == 1
    assert body["holdings"][0]["coin_id"] == "bitcoin"


def test_portfolio_buy_records_transaction(client, funded_headers):
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 500},
        headers=funded_headers,
    )
    txns = client.get("/api/portfolio", headers=funded_headers).json()["transactions"]
    buy_txns = [t for t in txns if t["type"] == "buy"]
    assert len(buy_txns) == 1
    assert buy_txns[0]["total"] == 500


def test_portfolio_buy_twice_averages_price(client, funded_headers):
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    )
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    )
    holdings = client.get("/api/portfolio", headers=funded_headers).json()["holdings"]
    assert len(holdings) == 1
    assert holdings[0]["coin_id"] == "bitcoin"


def test_portfolio_buy_insufficient_cash_returns_400(client, auth_headers):
    assert (
        client.post(
            "/api/portfolio/buy",
            json={"coin_id": "bitcoin", "usd_amount": 99_999},
            headers=auth_headers,
        ).status_code
        == 400
    )


def test_portfolio_buy_below_minimum_returns_400(client, auth_headers):
    assert (
        client.post(
            "/api/portfolio/buy",
            json={"coin_id": "bitcoin", "usd_amount": 0.5},
            headers=auth_headers,
        ).status_code
        == 400
    )


def test_portfolio_buy_unknown_coin_returns_404(client, auth_headers):
    assert (
        client.post(
            "/api/portfolio/buy",
            json={"coin_id": "dogecoin", "usd_amount": 100},
            headers=auth_headers,
        ).status_code
        == 404
    )


def test_portfolio_sell_reduces_holding(client, funded_headers):
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    )
    body = client.post(
        "/api/portfolio/sell",
        json={"coin_id": "bitcoin", "usd_amount": 500},
        headers=funded_headers,
    ).json()
    assert body["cash"] == pytest.approx(9_500.0)


def test_portfolio_sell_full_position_removes_holding(client, funded_headers):
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    )
    body = client.post(
        "/api/portfolio/sell",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    ).json()
    assert body["holdings"] == []


def test_portfolio_sell_no_holding_returns_400(client, auth_headers):
    assert (
        client.post(
            "/api/portfolio/sell",
            json={"coin_id": "bitcoin", "usd_amount": 100},
            headers=auth_headers,
        ).status_code
        == 400
    )


def test_portfolio_sell_over_value_returns_400(client, funded_headers):
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 100},
        headers=funded_headers,
    )
    assert (
        client.post(
            "/api/portfolio/sell",
            json={"coin_id": "bitcoin", "usd_amount": 99_999},
            headers=funded_headers,
        ).status_code
        == 400
    )


def test_portfolio_reset(client, funded_headers):
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    )
    body = client.post("/api/portfolio/reset", headers=funded_headers).json()
    assert body["cash"] == 0.0
    assert body["holdings"] == []
    assert body["transactions"] == []


def test_portfolio_deposit_adds_cash(client, auth_headers):
    body = client.post(
        "/api/portfolio/deposit", json={"amount": 5_000}, headers=auth_headers
    ).json()
    assert body["cash"] == pytest.approx(5_000.0)
    assert body["total_deposited"] == pytest.approx(5_000.0)
    assert body["net_invested"] == pytest.approx(5_000.0)


def test_portfolio_deposit_negative_returns_400(client, auth_headers):
    assert (
        client.post(
            "/api/portfolio/deposit", json={"amount": -100}, headers=auth_headers
        ).status_code
        == 400
    )


def test_portfolio_withdraw_reduces_cash(client, auth_headers):
    client.post("/api/portfolio/deposit", json={"amount": 5_000}, headers=auth_headers)
    body = client.post(
        "/api/portfolio/withdraw", json={"amount": 2_000}, headers=auth_headers
    ).json()
    assert body["cash"] == pytest.approx(3_000.0)
    assert body["total_withdrawn"] == pytest.approx(2_000.0)
    assert body["net_invested"] == pytest.approx(3_000.0)


def test_portfolio_withdraw_over_cash_returns_400(client, auth_headers):
    assert (
        client.post(
            "/api/portfolio/withdraw", json={"amount": 1_000}, headers=auth_headers
        ).status_code
        == 400
    )


def test_recommendation_requires_auth(client):
    assert client.get("/api/portfolio/recommendation").status_code == 401


def test_recommendation_empty_portfolio(client, auth_headers):
    body = client.get("/api/portfolio/recommendation", headers=auth_headers).json()
    assert "summary" in body
    assert "recommendations" in body
    assert "cash_pct" in body
    assert isinstance(body["recommendations"], list)


# ── /api/news ─────────────────────────────────────────────────────────────────


def test_news_returns_200(client):
    assert client.get("/api/news").status_code == 200


def test_news_shape(client):
    body = client.get("/api/news").json()
    assert "news" in body
    assert isinstance(body["news"], list)
    assert len(body["news"]) == 2


# ── /api/backtest ─────────────────────────────────────────────────────────────


def test_backtest_known_coin(client):
    body = client.get("/api/backtest/bitcoin").json()
    for key in ("forward_days", "total_signals", "buy", "sell", "hold", "recent"):
        assert key in body


def test_backtest_unknown_coin_returns_404(client):
    assert client.get("/api/backtest/dogecoin").status_code == 404


# ── /api/watchlist ────────────────────────────────────────────────────────────


def test_watchlist_requires_auth(client):
    assert client.get("/api/watchlist").status_code == 401


def test_watchlist_empty(client, auth_headers):
    assert client.get("/api/watchlist", headers=auth_headers).json() == []


def test_watchlist_add(client, auth_headers):
    client.post("/api/watchlist/bitcoin", headers=auth_headers)
    assert "bitcoin" in client.get("/api/watchlist", headers=auth_headers).json()


def test_watchlist_remove(client, auth_headers):
    client.post("/api/watchlist/bitcoin", headers=auth_headers)
    client.delete("/api/watchlist/bitcoin", headers=auth_headers)
    assert "bitcoin" not in client.get("/api/watchlist", headers=auth_headers).json()


def test_watchlist_add_idempotent(client, auth_headers):
    client.post("/api/watchlist/bitcoin", headers=auth_headers)
    client.post("/api/watchlist/bitcoin", headers=auth_headers)
    assert client.get("/api/watchlist", headers=auth_headers).json().count("bitcoin") == 1


# ── /api/portfolios ───────────────────────────────────────────────────────────


def test_portfolios_requires_auth(client):
    assert client.get("/api/portfolios").status_code == 401


def test_list_portfolios_returns_default(client, auth_headers):
    assert "default" in client.get("/api/portfolios", headers=auth_headers).json()


def test_create_portfolio(client, auth_headers):
    client.post("/api/portfolios", json={"name": "trading"}, headers=auth_headers)
    assert "trading" in client.get("/api/portfolios", headers=auth_headers).json()


def test_create_duplicate_portfolio_returns_409(client, auth_headers):
    client.post("/api/portfolios", json={"name": "dup"}, headers=auth_headers)
    assert (
        client.post("/api/portfolios", json={"name": "dup"}, headers=auth_headers).status_code
        == 409
    )


def test_delete_portfolio(client, auth_headers):
    client.post("/api/portfolios", json={"name": "temp"}, headers=auth_headers)
    assert client.delete("/api/portfolios/temp", headers=auth_headers).status_code == 200
    assert "temp" not in client.get("/api/portfolios", headers=auth_headers).json()


def test_delete_default_portfolio_returns_400(client, auth_headers):
    assert client.delete("/api/portfolios/default", headers=auth_headers).status_code == 400


def test_named_portfolio_independent(client, funded_headers):
    client.post("/api/portfolios", json={"name": "savings"}, headers=funded_headers)
    client.post(
        "/api/portfolio/deposit",
        json={"amount": 10_000, "portfolio": "savings"},
        headers=funded_headers,
    )
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 500, "portfolio": "savings"},
        headers=funded_headers,
    )
    default_cash = client.get("/api/portfolio", headers=funded_headers).json()["cash"]
    savings_cash = client.get("/api/portfolio?portfolio=savings", headers=funded_headers).json()[
        "cash"
    ]
    assert default_cash == pytest.approx(10_000.0)
    assert savings_cash == pytest.approx(9_500.0)


# ── /api/portfolio/history ────────────────────────────────────────────────────


def test_portfolio_history_requires_auth(client):
    assert client.get("/api/portfolio/history").status_code == 401


def test_portfolio_history_returns_list(client, auth_headers):
    client.get("/api/portfolio", headers=auth_headers)  # trigger snapshot
    body = client.get("/api/portfolio/history", headers=auth_headers).json()
    assert isinstance(body, list)
    assert len(body) >= 1
    assert "date" in body[0]
    assert "total_value" in body[0]


def test_users_portfolios_are_isolated(client, funded_headers, auth_headers):
    """Two different users should have independent portfolios."""
    # Admin buys bitcoin (has $10k from funded_headers deposit)
    client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": 1000},
        headers=funded_headers,
    )

    # Create and log in as a second user
    client.post(
        "/api/auth/users",
        json={"username": "alice", "password": "pass"},
        headers=auth_headers,
    )
    alice_token = client.post(
        "/api/auth/login", json={"username": "alice", "password": "pass"}
    ).json()["access_token"]
    alice_headers = {"Authorization": f"Bearer {alice_token}"}

    # Alice should start with $0 and no holdings
    alice_portfolio = client.get("/api/portfolio", headers=alice_headers).json()
    assert alice_portfolio["cash"] == 0.0
    assert alice_portfolio["holdings"] == []
