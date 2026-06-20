"""End-goal suite — portfolio integrity. Covers G4 (no money created/lost,
atomic writes, export), G13 (reads have no side effects), and G14
(recommendation P&L uses the live capital model)."""

from __future__ import annotations

import inspect

import pytest

import portfolio
import portfolio_history
from recommendation import recommend


# ── G4 — buy/sell conserves money to the cent ─────────────────────────────────


def test_money_is_conserved_across_buy_sell(client, auth_headers):
    """G4: with no price movement, total value always equals net invested.

    Mock prices are constant (BTC 67k, ETH 3.5k), so any sequence of
    buys/sells must leave total_value == deposits - withdrawals.
    """
    client.post("/api/portfolio/deposit", json={"amount": 10_000}, headers=auth_headers)

    moves = [
        ("buy", "bitcoin", 2_000),
        ("buy", "ethereum", 1_500),
        ("sell", "bitcoin", 1_000),
        ("buy", "bitcoin", 500),
        ("sell", "ethereum", 750),
    ]
    for action, coin, usd in moves:
        r = client.post(
            f"/api/portfolio/{action}",
            json={"coin_id": coin, "usd_amount": usd},
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text

    body = r.json()
    assert abs(body["total_value"] - body["net_invested"]) < 0.01
    assert abs(body["net_invested"] - 10_000) < 0.01


def test_avg_buy_price_is_weighted_average(client, auth_headers):
    """G4: averaging in a second lot recomputes avg_buy_price correctly."""
    client.post("/api/portfolio/deposit", json={"amount": 10_000}, headers=auth_headers)
    # Two buys at the same (constant mock) price → avg equals that price.
    client.post(
        "/api/portfolio/buy", json={"coin_id": "bitcoin", "usd_amount": 1_000}, headers=auth_headers
    )
    r = client.post(
        "/api/portfolio/buy", json={"coin_id": "bitcoin", "usd_amount": 1_000}, headers=auth_headers
    )
    holding = next(h for h in r.json()["holdings"] if h["coin_id"] == "bitcoin")
    assert abs(holding["avg_buy_price"] - 67_000.0) < 1e-6


@pytest.mark.xfail(reason="G4: save_portfolio is not atomic (no temp+rename)", strict=False)
def test_portfolio_writes_are_atomic():
    """G4: a crash mid-write must never truncate the file → write temp, then rename."""
    src = inspect.getsource(portfolio.save_portfolio)
    assert "os.replace" in src or ".rename(" in src


@pytest.mark.xfail(reason="G4: no portfolio export endpoint yet", strict=False)
def test_portfolio_export_endpoint_exists(client, auth_headers):
    """G4: users can export their portfolio + transactions (CSV/JSON)."""
    r = client.get("/api/portfolio/export", headers=auth_headers)
    assert r.status_code == 200


# ── G13 — GET /api/portfolio must be read-only ────────────────────────────────


@pytest.mark.xfail(reason="G13: GET writes a history snapshot as a side effect", strict=False)
def test_get_portfolio_does_not_write_history(client, auth_headers):
    """G13: reading the portfolio must not mutate on-disk state."""
    hist_path = portfolio_history._path("admin")
    assert not hist_path.exists()
    r = client.get("/api/portfolio", headers=auth_headers)
    assert r.status_code == 200
    assert not hist_path.exists()  # a pure read created nothing


# ── G14 — recommendation P&L uses net_invested, not legacy initial_cash ───────


def test_recommendation_pnl_uses_net_invested():
    """G14: a $500-funded portfolio worth $600 is up 20%, not down 94%."""
    pf = {
        "cash": 533.0,
        "total_deposited": 500.0,
        "total_withdrawn": 0.0,
        "holdings": {"bitcoin": {"amount": 0.001, "avg_buy_price": 50_000.0}},
        "transactions": [],
    }
    coins = {"bitcoin": {"current_price": 67_000.0, "symbol": "btc", "name": "Bitcoin"}}
    signals = {"bitcoin": {"composite_score": 50, "composite_verdict": "hold"}}

    res = recommend(pf, coins, signals, total_value=600.0)

    summary = res["summary"].lower()
    assert "up" in summary and "20" in summary
    assert "down" not in summary
