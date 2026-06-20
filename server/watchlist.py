"""Per-user coin watchlist."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

_WATCHLIST_DIR = Path(__file__).parent


def _path(username: str) -> Path:
    return _WATCHLIST_DIR / f"watchlist_{username}.json"


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


def load_watchlist(username: str) -> list[str]:
    p = _path(username)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def add_coin(username: str, coin_id: str) -> list[str]:
    wl = load_watchlist(username)
    if coin_id not in wl:
        wl.append(coin_id)
        _atomic_write_text(_path(username), json.dumps(wl))
    return wl


def remove_coin(username: str, coin_id: str) -> list[str]:
    wl = [c for c in load_watchlist(username) if c != coin_id]
    _atomic_write_text(_path(username), json.dumps(wl))
    return wl
