"""End-goal suite — frontend trust & shipping. Covers G16 (unmissable
disclaimer), G8's UI label, G15 (mobile/accessibility), and G11
(one-command cross-platform run)."""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "frontend" / "index.html"


# ── G16 — not-financial-advice disclaimer is visible in the UI ────────────────


@pytest.mark.xfail(reason="G16: no not-financial-advice disclaimer in the UI", strict=False)
def test_frontend_has_not_financial_advice_disclaimer():
    html = INDEX.read_text().lower()
    assert "not financial advice" in html or "educational" in html


# ── G8 (UI) — the ML score is labeled experimental wherever shown ─────────────


def test_frontend_labels_ml_experimental():
    html = INDEX.read_text().lower()
    assert "experimental" in html


# ── G15 — mobile-first & accessible ───────────────────────────────────────────


def test_frontend_declares_mobile_viewport():
    """G15 (floor): a mobile-first app must declare a responsive viewport."""
    html = INDEX.read_text().lower()
    assert 'name="viewport"' in html and "width=device-width" in html


def test_frontend_interactive_controls_have_accessible_names():
    """G15 (floor, met): every <button> exposes text or an aria-label."""
    import re

    html = INDEX.read_text()
    buttons = re.findall(r"<button\b[^>]*>(.*?)</button>", html, flags=re.S)
    assert buttons  # there are buttons to check
    for inner in buttons:
        assert inner.strip() != "" or "aria-label" in inner


@pytest.mark.xfail(
    reason="G15: Lighthouse/axe accessibility audit (>=90) not wired into CI", strict=False
)
def test_accessibility_audit_is_enforced():
    """G15: a Lighthouse/axe accessibility gate (>=90) must run in CI."""
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text().lower()
    assert "lighthouse" in ci or "axe" in ci or "pa11y" in ci


# ── G11 — one-command, cross-platform run ─────────────────────────────────────


@pytest.mark.xfail(reason="G11: no Dockerfile / Makefile for cross-platform run", strict=False)
def test_cross_platform_run_artifact_exists():
    assert (ROOT / "Dockerfile").exists() or (ROOT / "Makefile").exists()
