"""JWT creation/verification and password hashing."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

logger = logging.getLogger(__name__)

_DEV_SECRET = "pulsar-dev-secret-change-before-deploying"

SECRET_KEY = os.environ.get("PULSAR_SECRET_KEY", _DEV_SECRET)
ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = int(os.environ.get("PULSAR_TOKEN_EXPIRE_MINUTES", "60"))

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def warn_insecure_defaults() -> bool:
    """Log a prominent WARNING when the app is running with bundled dev defaults.

    Returns True if any insecure default was detected (handy for tests and for
    surfacing a banner in the UI). Fires when ``PULSAR_SECRET_KEY`` is still the
    bundled dev secret or ``PULSAR_ADMIN_PASSWORD`` is the seeded ``admin``.
    """
    insecure = False
    if SECRET_KEY == _DEV_SECRET:
        insecure = True
        logger.warning(
            "INSECURE DEFAULT: PULSAR_SECRET_KEY is the bundled dev secret. "
            "Generate a real one with `openssl rand -hex 32` and set it in .env "
            "before exposing this instance."
        )
    if os.environ.get("PULSAR_ADMIN_PASSWORD", "admin") == "admin":
        insecure = True
        logger.warning(
            "INSECURE DEFAULT: the admin password is 'admin'. Set "
            "PULSAR_ADMIN_PASSWORD in .env before exposing this instance."
        )
    return insecure


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd.verify(plain, hashed)


def create_token(username: str, is_admin: bool) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    return jwt.encode(
        {"sub": username, "admin": is_admin, "exp": expire},
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> Optional[dict]:
    """Return decoded payload or None if the token is invalid or expired."""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
