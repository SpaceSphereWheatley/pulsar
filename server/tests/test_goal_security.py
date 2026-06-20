"""End-goal suite — security posture. Covers G3 (no silent insecure defaults)
and G12 (tightened, configurable CORS)."""

from __future__ import annotations

from pathlib import Path

import pytest

import auth
import main

SERVER = Path(__file__).resolve().parents[1]


# ── G3 — insecure defaults must not reach a running instance unnoticed ────────


def test_dev_secret_placeholder_lives_in_code():
    """G3 (context): the foot-gun exists — a bundled dev secret is the fallback."""
    src = (SERVER / "auth.py").read_text()
    assert "pulsar-dev-secret-change-before-deploying" in src
    assert auth.SECRET_KEY  # always resolves to *something*


def test_startup_warns_on_insecure_defaults():
    """G3: there must be a check that warns loudly on default secret/password."""
    assert hasattr(main, "warn_insecure_defaults") or hasattr(auth, "warn_insecure_defaults")


def test_warn_insecure_defaults_fires_on_dev_secret(monkeypatch, caplog):
    """G3: the check logs a WARNING and reports insecure when defaults are in use."""
    monkeypatch.setattr(auth, "SECRET_KEY", auth._DEV_SECRET)
    monkeypatch.setenv("PULSAR_ADMIN_PASSWORD", "admin")
    with caplog.at_level("WARNING"):
        assert auth.warn_insecure_defaults() is True
    assert any("INSECURE DEFAULT" in r.message for r in caplog.records)


def test_warn_insecure_defaults_silent_when_hardened(monkeypatch):
    """G3: no false positive when a real secret and admin password are set."""
    monkeypatch.setattr(auth, "SECRET_KEY", "a-real-32-byte-secret-value-here-ok")
    monkeypatch.setenv("PULSAR_ADMIN_PASSWORD", "s3cret-passw0rd")
    assert auth.warn_insecure_defaults() is False


# ── G12 — CORS is configurable, not a hard-coded wildcard ─────────────────────


@pytest.mark.xfail(reason="G12: CORS allow_origins is hard-coded to ['*']", strict=False)
def test_cors_is_not_wildcard():
    """G12: allowed origins should come from config, not a literal '*'."""
    src = (SERVER / "main.py").read_text()
    assert 'allow_origins=["*"]' not in src
