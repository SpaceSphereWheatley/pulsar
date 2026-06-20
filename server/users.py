"""User storage backed by a local JSON file."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from auth import hash_password, verify_password

USERS_FILE = Path(__file__).parent / "users.json"

_ADMIN_USERNAME: str = os.environ.get("PULSAR_ADMIN_USERNAME", "admin")
_ADMIN_PASSWORD: str = os.environ.get("PULSAR_ADMIN_PASSWORD", "admin")


def _load() -> dict:
    if USERS_FILE.exists():
        try:
            return json.loads(USERS_FILE.read_text())
        except Exception:
            pass
    return {}


def _save(data: dict) -> None:
    # Atomic write: temp file in the same dir, then os.replace, so a crash
    # mid-write can never truncate users.json.
    fd, tmp = tempfile.mkstemp(dir=str(USERS_FILE.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2))
        os.replace(tmp, USERS_FILE)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def seed_admin() -> None:
    """Create the admin account on first run if it does not exist yet."""
    data = _load()
    if _ADMIN_USERNAME not in data:
        data[_ADMIN_USERNAME] = {
            "hashed_password": hash_password(_ADMIN_PASSWORD),
            "is_admin": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": None,
        }
        _save(data)


def authenticate(username: str, password: str) -> Optional[dict]:
    """Return {username, is_admin} or None on bad credentials."""
    data = _load()
    record = data.get(username)
    if record is None or not verify_password(password, record["hashed_password"]):
        return None
    return {"username": username, "is_admin": record["is_admin"]}


def create_user(username: str, password: str, created_by: str) -> dict:
    """Create a non-admin user. Raises ValueError if the username is taken."""
    data = _load()
    if username in data:
        raise ValueError(f"User '{username}' already exists")
    data[username] = {
        "hashed_password": hash_password(password),
        "is_admin": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": created_by,
    }
    _save(data)
    return {"username": username, "is_admin": False}


def list_users() -> list[dict]:
    data = _load()
    return [
        {
            "username": u,
            "is_admin": d["is_admin"],
            "created_at": d["created_at"],
            "created_by": d.get("created_by"),
        }
        for u, d in data.items()
    ]


def change_password(username: str, current_password: str, new_password: str) -> bool:
    """Verify the current password and set a new bcrypt hash.

    Returns False if the user is unknown or the current password is wrong.
    """
    data = _load()
    record = data.get(username)
    if record is None or not verify_password(current_password, record["hashed_password"]):
        return False
    record["hashed_password"] = hash_password(new_password)
    _save(data)
    return True


def delete_user(username: str) -> bool:
    """Delete a non-admin user. Returns False if not found or is admin."""
    data = _load()
    record = data.get(username)
    if record is None or record.get("is_admin"):
        return False
    del data[username]
    _save(data)
    return True
