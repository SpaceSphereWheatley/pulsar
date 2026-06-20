"""Per-user daily portfolio value snapshots (one per day, kept 365 days)."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import date
from pathlib import Path

_HISTORY_DIR = Path(__file__).parent


def _path(username: str, pf_name: str = "default") -> Path:
    suffix = "" if pf_name == "default" else f"_{pf_name}"
    return _HISTORY_DIR / f"portfolio_history_{username}{suffix}.json"


def _atomic_write_text(path: Path, text: str) -> None:
    """Write via temp file + os.replace so a crash never truncates the file."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_history(username: str, pf_name: str = "default") -> list[dict]:
    p = _path(username, pf_name)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def record_snapshot(
    username: str,
    total_value: float,
    cash: float,
    pnl_pct: float,
    pf_name: str = "default",
) -> None:
    """Upsert today's snapshot. Safe to call on every portfolio read."""
    history = load_history(username, pf_name)
    today = date.today().isoformat()
    history = [h for h in history if h["date"] != today]
    history.append(
        {
            "date": today,
            "total_value": round(total_value, 2),
            "cash": round(cash, 2),
            "pnl_pct": round(pnl_pct, 2),
        }
    )
    history = sorted(history, key=lambda x: x["date"])[-365:]
    _atomic_write_text(_path(username, pf_name), json.dumps(history))
