"""End-goal suite — API contract hardening. Covers G6 (resilience + health
endpoint), G7 (request validation → 422 not 500), and G10 (self-service
password change)."""

from __future__ import annotations

from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parents[1]


# ── G6 — health endpoint + retry/backoff on outbound fetches ──────────────────


def test_health_endpoint_reports_cache_freshness(client):
    """G6: /api/health reports per-cache age and an overall ok|degraded status."""
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] in {"ok", "degraded"}
    assert "caches" in body


def test_fetches_use_retry_with_backoff():
    """G6: data fetching must retry transient failures with backoff."""
    src = (SERVER / "data.py").read_text().lower()
    assert "backoff" in src or "retry" in src


# ── G7 — malformed request bodies return 422, never a 500 ─────────────────────


@pytest.mark.xfail(reason="G7: buy uses raw dict + float(); non-numeric → 500", strict=False)
def test_buy_with_non_numeric_amount_returns_422(client, auth_headers):
    r = client.post(
        "/api/portfolio/buy",
        json={"coin_id": "bitcoin", "usd_amount": "not-a-number"},
        headers=auth_headers,
    )
    assert r.status_code == 422


@pytest.mark.xfail(reason="G7: deposit uses raw dict; wrong type → 500/400, not 422", strict=False)
def test_deposit_with_wrong_type_returns_422(client, auth_headers):
    r = client.post(
        "/api/portfolio/deposit",
        json={"amount": {"nested": "object"}},
        headers=auth_headers,
    )
    assert r.status_code == 422


@pytest.mark.xfail(reason="G7: login accepts a raw dict with no schema", strict=False)
def test_login_with_wrong_field_type_returns_422(client):
    r = client.post("/api/auth/login", json={"username": 123, "password": ["x"]})
    assert r.status_code == 422


# ── G10 — a non-admin user can change their own password ──────────────────────


@pytest.mark.xfail(reason="G10: no self-service password-change endpoint", strict=False)
def test_password_change_endpoint(client, auth_headers):
    """G10: an authenticated user can change their password and re-login."""
    r = client.post(
        "/api/auth/password",
        json={"current_password": "admin", "new_password": "brand-new-pw"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    again = client.post("/api/auth/login", json={"username": "admin", "password": "brand-new-pw"})
    assert again.status_code == 200
