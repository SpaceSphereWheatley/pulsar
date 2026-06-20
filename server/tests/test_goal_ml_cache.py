"""End-goal suite — ML honesty/durability (G8) and cache persistence (G9)."""

from __future__ import annotations

from pathlib import Path

import pytest

import data
import ml

SERVER = Path(__file__).resolve().parents[1]


# ── G8 — ML score is honest and durable ───────────────────────────────────────


def test_ml_score_is_none_for_unknown_coin():
    """G8 (context): the score is optional and honest — None when not trained."""
    assert ml.get_ml_score("does-not-exist") is None


@pytest.mark.xfail(reason="G8: ML scores are in-memory only; lost on restart", strict=False)
def test_ml_scores_persist_to_disk():
    """G8: scores must survive a restart (load/save helpers exist)."""
    assert hasattr(ml, "save_scores") and hasattr(ml, "load_scores")


@pytest.mark.xfail(reason="G8: /api/signals exposes no ML quality metric", strict=False)
def test_signals_expose_ml_quality_metric(client):
    """G8: each signal must carry an auditable ML quality metric (e.g. hit-rate)."""
    r = client.get("/api/signals")
    assert r.status_code == 200
    sig = r.json()["signals"][0]
    assert "ml_quality" in sig or "ml_hit_rate" in sig


# ── G9 — caches survive a cold start ──────────────────────────────────────────


@pytest.mark.xfail(reason="G9: caches are not persisted to disk", strict=False)
def test_cache_persistence_helpers_exist():
    """G9: caches must persist to cache.json and load on boot."""
    assert hasattr(data, "save_caches") and hasattr(data, "load_caches")


@pytest.mark.xfail(reason="G9: no boot-from-cache path; cold start hits the API", strict=False)
def test_boot_loads_cache_without_network(tmp_path, monkeypatch):
    """G9: after a restart, the first request serves cache with no external call."""
    monkeypatch.setattr(data, "_coins_cache", {})
    data.load_caches()  # attribute error today → xfail
    assert data._coins_cache  # populated from disk, no network
