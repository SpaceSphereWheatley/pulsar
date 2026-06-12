"""Virtual portfolio — per-user JSON persistence."""

import json
import re
from pathlib import Path

_PORTFOLIO_DIR = Path(__file__).parent
_INITIAL_CASH = 0.0
_SAFE_NAME_RE = re.compile(r"^[a-z0-9_\-]{1,32}$")


def _safe_name(name: str) -> str:
    n = name.strip().lower()
    if not _SAFE_NAME_RE.match(n):
        raise ValueError(
            "Portfolio name must be 1-32 lowercase alphanumeric, hyphens, or underscores"
        )
    return n


def _path(username: str, name: str = "default") -> Path:
    suffix = "" if name == "default" else f"_{name}"
    return _PORTFOLIO_DIR / f"portfolio_{username}{suffix}.json"


def _empty() -> dict:
    return {
        "cash": _INITIAL_CASH,
        "total_deposited": _INITIAL_CASH,
        "total_withdrawn": 0.0,
        "holdings": {},
        "transactions": [],
    }


def load_portfolio(username: str, name: str = "default") -> dict:
    p = _path(username, name)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return _empty()


def save_portfolio(username: str, portfolio: dict, name: str = "default") -> None:
    _path(username, name).write_text(json.dumps(portfolio, indent=2))


def reset_portfolio(username: str, name: str = "default") -> dict:
    fresh = _empty()
    save_portfolio(username, fresh, name)
    return fresh


def list_portfolios(username: str) -> list[str]:
    """Return all portfolio names for the user; always includes 'default'."""
    others = sorted(
        p.stem.removeprefix(f"portfolio_{username}_")
        for p in _PORTFOLIO_DIR.glob(f"portfolio_{username}_*.json")
    )
    has_default = _path(username, "default").exists()
    if has_default or not others:
        return ["default"] + others
    return others


def create_portfolio(username: str, name: str) -> dict:
    safe = _safe_name(name)
    if _path(username, safe).exists():
        raise ValueError(f"Portfolio '{safe}' already exists")
    fresh = _empty()
    save_portfolio(username, fresh, safe)
    return fresh


def delete_portfolio(username: str, name: str) -> None:
    safe = _safe_name(name)
    if safe == "default":
        raise ValueError("Cannot delete the default portfolio")
    p = _path(username, safe)
    if not p.exists():
        raise FileNotFoundError(f"Portfolio '{safe}' not found")
    p.unlink()
