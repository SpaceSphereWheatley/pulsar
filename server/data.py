import asyncio
import logging
import os
import time
from typing import Optional

import httpx
from pycoingecko import CoinGeckoAPI

logger = logging.getLogger(__name__)

# ── Outbound resilience ───────────────────────────────────────────────────────
# Every outbound fetch goes through bounded retry with exponential backoff so a
# transient flake/rate-limit doesn't wipe the last-good cache.
_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY = 0.5  # seconds; doubled after each failed attempt


def _with_retry(fn, *args, **kwargs):
    """Call a sync fetch with bounded retry + exponential backoff; re-raise last error."""
    delay = _RETRY_BASE_DELAY
    last_exc: Optional[Exception] = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - retry any transient failure
            last_exc = exc
            if attempt < _RETRY_ATTEMPTS:
                logger.warning(
                    "fetch attempt %d/%d failed: %s; backing off %.1fs",
                    attempt,
                    _RETRY_ATTEMPTS,
                    exc,
                    delay,
                )
                time.sleep(delay)
                delay *= 2
    raise last_exc  # type: ignore[misc]


async def _with_retry_async(coro_fn, *args, **kwargs):
    """Call an async fetch with bounded retry + exponential backoff; re-raise last error."""
    delay = _RETRY_BASE_DELAY
    last_exc: Optional[Exception] = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            return await coro_fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - retry any transient failure
            last_exc = exc
            if attempt < _RETRY_ATTEMPTS:
                logger.warning(
                    "fetch attempt %d/%d failed: %s; backing off %.1fs",
                    attempt,
                    _RETRY_ATTEMPTS,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)
                delay *= 2
    raise last_exc  # type: ignore[misc]


_demo_key = os.environ.get("COINGECKO_API_KEY", "")
_pro_key = os.environ.get("COINGECKO_PRO_API_KEY", "")

if _pro_key:
    cg = CoinGeckoAPI(api_key=_pro_key)
elif _demo_key:
    cg = CoinGeckoAPI(demo_api_key=_demo_key)
else:
    logger.warning(
        "No COINGECKO_API_KEY set — OHLC and market_chart endpoints require a free "
        "Demo key from https://www.coingecko.com/en/api/pricing"
    )
    cg = CoinGeckoAPI()

# ── In-memory cache ──────────────────────────────────────────────────────────

_coins_cache: dict = {}
_coins_cache_ts: float = 0.0
_COINS_TTL = 60  # seconds

_ohlc_cache: dict[str, dict] = {}  # coin_id → {data, ts}
_OHLC_TTL = 6 * 3600  # 6 hours

_feargreed_cache: dict = {}
_feargreed_cache_ts: float = 0.0
_FEARGREED_TTL = 3600  # 1 hour

TOP_N = 10


# ── Coins ────────────────────────────────────────────────────────────────────


def _fetch_coins_raw() -> list[dict]:
    return cg.get_coins_markets(
        vs_currency="usd",
        order="market_cap_desc",
        per_page=TOP_N,
        page=1,
        sparkline=False,
        price_change_percentage="24h,7d",
    )


def refresh_coins() -> None:
    global _coins_cache, _coins_cache_ts
    try:
        raw = _with_retry(_fetch_coins_raw)
        _coins_cache = {coin["id"]: coin for coin in raw}
        _coins_cache_ts = time.time()
        logger.info("Coins cache refreshed (%d coins)", len(_coins_cache))
    except Exception as exc:
        logger.error("Failed to refresh coins: %s", exc)


def get_coins_cache() -> tuple[dict, float]:
    """Return (cache_dict, timestamp). Caller decides freshness."""
    if not _coins_cache or time.time() - _coins_cache_ts > _COINS_TTL:
        refresh_coins()
    return _coins_cache, _coins_cache_ts


def get_coin_price(coin_id: str) -> Optional[float]:
    cache, _ = get_coins_cache()
    coin = cache.get(coin_id)
    return coin["current_price"] if coin else None


# ── OHLC history ─────────────────────────────────────────────────────────────


def _fetch_ohlc_raw(coin_id: str, days: int = 14) -> list:
    """Returns list of [timestamp_ms, open, high, low, close] from CoinGecko.

    days=1–30 yields 4-hour candles. days=31+ yields 4-day candles (~22 points),
    which is too few for RSI/MACD/BB calculations (minimum 30 required).
    """
    return cg.get_coin_ohlc_by_id(id=coin_id, vs_currency="usd", days=days)


def refresh_ohlc(coin_id: str) -> None:
    try:
        raw = _with_retry(_fetch_ohlc_raw, coin_id)
        _ohlc_cache[coin_id] = {"data": raw, "ts": time.time()}
        logger.info("OHLC cache refreshed for %s (%d candles)", coin_id, len(raw))
    except Exception as exc:
        logger.error("Failed to refresh OHLC for %s: %s", coin_id, exc)


def get_ohlc(coin_id: str) -> Optional[list]:
    entry = _ohlc_cache.get(coin_id)
    if not entry or time.time() - entry["ts"] > _OHLC_TTL:
        refresh_ohlc(coin_id)
        entry = _ohlc_cache.get(coin_id)
    return entry["data"] if entry else None


def refresh_all_ohlc() -> None:
    cache, _ = get_coins_cache()
    for coin_id in cache:
        refresh_ohlc(coin_id)


# ── Fear & Greed ─────────────────────────────────────────────────────────────


async def _fetch_feargreed_raw() -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get("https://api.alternative.me/fng/?limit=7")
        resp.raise_for_status()
        return resp.json()


async def refresh_feargreed() -> None:
    global _feargreed_cache, _feargreed_cache_ts
    try:
        _feargreed_cache = await _with_retry_async(_fetch_feargreed_raw)
        _feargreed_cache_ts = time.time()
        logger.info("Fear & Greed cache refreshed")
    except Exception as exc:
        logger.error("Failed to refresh Fear & Greed: %s", exc)


def get_feargreed_cache() -> tuple[dict, float]:
    return _feargreed_cache, _feargreed_cache_ts


# ── News ─────────────────────────────────────────────────────────────────────

_news_cache: list = []
_news_cache_ts: float = 0.0
_NEWS_TTL = 1800  # 30 minutes

# ── NOK exchange rate ─────────────────────────────────────────────────────────

_nok_rate: float = 10.5  # fallback USD→NOK
_nok_rate_ts: float = 0.0
_NOK_TTL = 3600  # 1 hour


async def _fetch_news_raw() -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get("https://api.coingecko.com/api/v3/news")
        resp.raise_for_status()
        return resp.json()


async def refresh_news() -> None:
    global _news_cache, _news_cache_ts
    try:
        payload = await _with_retry_async(_fetch_news_raw)
        _news_cache = payload.get("data", [])[:20]
        _news_cache_ts = time.time()
        logger.info("News cache refreshed (%d items)", len(_news_cache))
    except Exception as exc:
        logger.error("Failed to refresh news: %s", exc)


def get_news_cache() -> tuple[list, float]:
    return _news_cache, _news_cache_ts


async def _fetch_nok_raw() -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get("https://api.frankfurter.app/latest?from=USD&to=NOK")
        resp.raise_for_status()
        return resp.json()


async def refresh_nok_rate() -> None:
    global _nok_rate, _nok_rate_ts
    try:
        payload = await _with_retry_async(_fetch_nok_raw)
        _nok_rate = float(payload["rates"]["NOK"])
        _nok_rate_ts = time.time()
        logger.info("NOK rate refreshed: %.4f", _nok_rate)
    except Exception as exc:
        logger.error("Failed to refresh NOK rate: %s", exc)


def get_nok_rate() -> float:
    return _nok_rate


# ── Startup init ─────────────────────────────────────────────────────────────


_CACHE_FILE = os.path.join(os.path.dirname(__file__), "cache.json")


def save_caches() -> None:
    """Persist warm caches to server/cache.json so a cold start needs no network."""
    import json
    import tempfile

    payload = {
        "coins": _coins_cache,
        "coins_ts": _coins_cache_ts,
        "ohlc": _ohlc_cache,
        "feargreed": _feargreed_cache,
        "feargreed_ts": _feargreed_cache_ts,
        "news": _news_cache,
        "news_ts": _news_cache_ts,
        "nok_rate": _nok_rate,
        "nok_rate_ts": _nok_rate_ts,
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(_CACHE_FILE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(payload))
        os.replace(tmp, _CACHE_FILE)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_caches() -> None:
    """Load persisted caches on boot. Only fills caches that are currently empty,
    so a warm process is never clobbered by stale disk data."""
    import json

    global _coins_cache, _coins_cache_ts, _ohlc_cache
    global _feargreed_cache, _feargreed_cache_ts
    global _news_cache, _news_cache_ts, _nok_rate, _nok_rate_ts

    if not os.path.exists(_CACHE_FILE):
        return
    try:
        payload = json.loads(open(_CACHE_FILE).read())
    except Exception as exc:
        logger.warning("Could not load persisted caches: %s", exc)
        return

    if not _coins_cache and payload.get("coins"):
        _coins_cache = payload["coins"]
        _coins_cache_ts = payload.get("coins_ts", 0.0)
    if not _ohlc_cache and payload.get("ohlc"):
        _ohlc_cache = payload["ohlc"]
    if not _feargreed_cache and payload.get("feargreed"):
        _feargreed_cache = payload["feargreed"]
        _feargreed_cache_ts = payload.get("feargreed_ts", 0.0)
    if not _news_cache and payload.get("news"):
        _news_cache = payload["news"]
        _news_cache_ts = payload.get("news_ts", 0.0)
    if not _nok_rate_ts and payload.get("nok_rate"):
        _nok_rate = payload["nok_rate"]
        _nok_rate_ts = payload.get("nok_rate_ts", 0.0)
    logger.info("Loaded persisted caches from %s", _CACHE_FILE)


def cache_ages() -> dict:
    """Per-cache freshness for /api/health: age in seconds (None if never filled)."""
    now = time.time()

    def age(ts: float) -> Optional[float]:
        return round(now - ts, 1) if ts else None

    ohlc_ts = max((e["ts"] for e in _ohlc_cache.values()), default=0.0)
    return {
        "coins": {"age_seconds": age(_coins_cache_ts), "count": len(_coins_cache)},
        "ohlc": {"age_seconds": age(ohlc_ts), "count": len(_ohlc_cache)},
        "feargreed": {"age_seconds": age(_feargreed_cache_ts)},
        "news": {"age_seconds": age(_news_cache_ts), "count": len(_news_cache)},
        "nok_rate": {"age_seconds": age(_nok_rate_ts)},
    }


def init_data() -> None:
    """Synchronous init: fetch coins + OHLC on startup."""
    refresh_coins()
    refresh_all_ohlc()
