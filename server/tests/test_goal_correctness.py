"""End-goal suite — correctness & documentation truth.

Covers G1 (quality/resilience of data layer), G2 (docs match code),
and G5 (graceful behavior when market history is missing).

Convention: goals already met are real assertions; goals not yet
implemented are marked ``xfail`` with the goal ID, so the suite stays
green and each open goal flips to XPASS the moment it is delivered.
See ``server/tests/README_GOALS.md`` for the full map.
"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path

import data
import portfolio

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent


# ── G1 — data layer survives external API failure (resilience floor) ──────────


def test_refresh_coins_survives_api_failure(monkeypatch):
    """G1: a failed CoinGecko call must not crash or wipe the last-good cache."""
    sentinel = {"bitcoin": {"id": "bitcoin", "current_price": 1.0}}
    monkeypatch.setattr(data, "_coins_cache", sentinel.copy())
    monkeypatch.setattr(
        data, "_fetch_coins_raw", lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    )

    data.refresh_coins()  # must not raise

    assert data._coins_cache == sentinel  # untouched on failure


def test_refresh_ohlc_survives_api_failure(monkeypatch):
    """G1: a failed OHLC fetch must not raise and must leave the cache intact."""
    monkeypatch.setattr(data, "_ohlc_cache", {})
    monkeypatch.setattr(
        data, "_fetch_ohlc_raw", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    )

    data.refresh_ohlc("bitcoin")  # must not raise

    assert "bitcoin" not in data._ohlc_cache


def test_refresh_feargreed_survives_api_failure(monkeypatch):
    """G1: an async fetch failure leaves the previous Fear & Greed cache served."""
    prev = {"data": [{"value": "50", "value_classification": "Neutral"}]}
    monkeypatch.setattr(data, "_feargreed_cache", prev)

    class _Boom:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            raise RuntimeError("network down")

    monkeypatch.setattr(data.httpx, "AsyncClient", lambda *a, **k: _Boom())

    asyncio.run(data.refresh_feargreed())

    assert data._feargreed_cache == prev  # last-good preserved


def test_coverage_gate_is_at_least_80_percent():
    """G1: CI must enforce >= 80% coverage."""
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert "--cov-fail-under=80" in ci or "--cov-fail-under=85" in ci


# ── G2 — documentation matches the code (zero drift) ──────────────────────────
# Real tests: the code constants that the docs are supposed to describe.


def test_ohlc_window_default_is_14_days():
    """G2: OHLC window is 14 days (docs still say 90 in places)."""
    assert inspect.signature(data._fetch_ohlc_raw).parameters["days"].default == 14


def test_indicators_are_hand_rolled_not_pandas_ta():
    """G2: indicators are computed in-repo, not via pandas-ta."""
    src = (SERVER / "indicators.py").read_text()
    assert "pandas_ta" not in src and "pandas-ta" not in src


def test_requirements_do_not_depend_on_pandas_ta():
    """G2: requirements.txt must not list pandas-ta (it is not used)."""
    reqs = (ROOT / "requirements.txt").read_text()
    assert "pandas-ta" not in reqs and "pandas_ta" not in reqs


def test_portfolio_starts_at_zero_with_deposit_model():
    """G2: portfolios start at $0 and track deposits/withdrawals (not initial_cash=10k)."""
    assert portfolio._INITIAL_CASH == 0.0
    empty = portfolio._empty()
    assert empty["cash"] == 0.0
    assert "total_deposited" in empty and "total_withdrawn" in empty
    assert "initial_cash" not in empty


# xfail tests: the five named doc drifts from G2. These flip to XPASS once the
# prose is corrected — that is the signal G2 is done.


def test_pulsardocs_states_14_day_window():
    docs = (ROOT / "docs" / "pulsardocs.md").read_text()
    assert "90-day" not in docs and "90 days of daily OHLC" not in docs


def test_pulsardocs_no_pandas_ta_claim():
    docs = (ROOT / "docs" / "pulsardocs.md").read_text()
    assert "pandas-ta" not in docs


def test_readme_phase_table_not_stale():
    readme = (ROOT / "README.md").read_text()
    assert "Pending" not in readme


def test_pulsardocs_portfolio_starts_at_zero():
    docs = (ROOT / "docs" / "pulsardocs.md").read_text()
    assert "Cash: $10,000" not in docs and '"initial_cash": 10000' not in docs


# ── G5 — graceful behavior when OHLC history is missing ───────────────────────


def test_coins_endpoint_ok_without_ohlc(client):
    """G5: /api/coins returns 200 (indicators null) when no OHLC is cached."""
    data._ohlc_cache = {}
    r = client.get("/api/coins")
    assert r.status_code == 200
    assert all(c["indicators"] is None for c in r.json()["coins"])


def test_signals_endpoint_ok_without_ohlc(client):
    """G5: /api/signals returns 200 and degrades to neutral when OHLC is absent."""
    data._ohlc_cache = {}
    r = client.get("/api/signals")
    assert r.status_code == 200
    assert len(r.json()["signals"]) > 0


def test_backtest_is_structured_404_not_500_without_ohlc(client):
    """G5: backtest without history returns a clean 404, never a 500."""
    data._ohlc_cache = {}
    r = client.get("/api/backtest/bitcoin")
    assert r.status_code == 404
