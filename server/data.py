import os
import time
import logging
from typing import Optional

import httpx
from pycoingecko import CoinGeckoAPI

logger = logging.getLogger(__name__)

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
        raw = _fetch_coins_raw()
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
        raw = _fetch_ohlc_raw(coin_id)
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


async def refresh_feargreed() -> None:
    global _feargreed_cache, _feargreed_cache_ts
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://api.alternative.me/fng/?limit=7")
            resp.raise_for_status()
            _feargreed_cache = resp.json()
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


async def refresh_news() -> None:
    global _news_cache, _news_cache_ts
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://api.coingecko.com/api/v3/news")
            resp.raise_for_status()
            payload = resp.json()
            _news_cache = payload.get("data", [])[:20]
            _news_cache_ts = time.time()
            logger.info("News cache refreshed (%d items)", len(_news_cache))
    except Exception as exc:
        logger.error("Failed to refresh news: %s", exc)


def get_news_cache() -> tuple[list, float]:
    return _news_cache, _news_cache_ts


async def refresh_nok_rate() -> None:
    global _nok_rate, _nok_rate_ts
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://api.frankfurter.app/latest?from=USD&to=NOK")
            resp.raise_for_status()
            _nok_rate = float(resp.json()["rates"]["NOK"])
            _nok_rate_ts = time.time()
            logger.info("NOK rate refreshed: %.4f", _nok_rate)
    except Exception as exc:
        logger.error("Failed to refresh NOK rate: %s", exc)


def get_nok_rate() -> float:
    return _nok_rate


# ── Startup init ─────────────────────────────────────────────────────────────


def init_data() -> None:
    """Synchronous init: fetch coins + OHLC on startup."""
    refresh_coins()
    refresh_all_ohlc()
