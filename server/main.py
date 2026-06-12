import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from dotenv import load_dotenv

load_dotenv()

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from fastapi.staticfiles import StaticFiles

from auth import create_token, decode_token
from backtest import run_backtest
from data import (
    get_coin_price,
    get_coins_cache,
    get_feargreed_cache,
    get_news_cache,
    get_nok_rate,
    get_ohlc,
    init_data,
    refresh_feargreed,
    refresh_news,
    refresh_nok_rate,
)
from indicators import compute_indicators, compute_signal
from ml import get_ml_score
from portfolio import (
    create_portfolio,
    delete_portfolio,
    list_portfolios,
    load_portfolio,
    reset_portfolio,
    save_portfolio,
)
from portfolio_history import load_history, record_snapshot
from recommendation import recommend
from scheduler import scheduler
from users import authenticate, create_user, delete_user, list_users, seed_admin
from watchlist import add_coin as wl_add
from watchlist import load_watchlist
from watchlist import remove_coin as wl_remove

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ── Auth helpers ──────────────────────────────────────────────────────────────

_oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(token: str = Depends(_oauth2)) -> dict:
    payload = decode_token(token)
    if payload is None:
        raise HTTPException(401, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    return {"username": payload["sub"], "is_admin": payload.get("admin", False)}


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(403, "Admin access required")
    return user


# ── App lifecycle ─────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up…")
    seed_admin()
    init_data()
    await refresh_feargreed()
    await refresh_news()
    await refresh_nok_rate()

    import asyncio

    scheduler.add_job(
        __import__("data").refresh_coins,
        "interval",
        seconds=60,
        id="refresh_coins",
        replace_existing=True,
    )
    scheduler.add_job(
        __import__("data").refresh_all_ohlc,
        "interval",
        hours=6,
        id="refresh_ohlc",
        replace_existing=True,
    )
    scheduler.add_job(
        lambda: asyncio.ensure_future(refresh_feargreed()),
        "interval",
        hours=1,
        id="refresh_feargreed",
        replace_existing=True,
    )
    scheduler.add_job(
        _refresh_ml,
        "interval",
        hours=6,
        id="refresh_ml",
        replace_existing=True,
    )
    scheduler.add_job(
        lambda: asyncio.ensure_future(refresh_news()),
        "interval",
        minutes=30,
        id="refresh_news",
        replace_existing=True,
    )
    scheduler.add_job(
        lambda: asyncio.ensure_future(refresh_nok_rate()),
        "interval",
        hours=1,
        id="refresh_nok_rate",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Scheduler started")
    yield
    scheduler.shutdown(wait=False)
    logger.info("Scheduler stopped")


def _refresh_ml() -> None:
    from data import _ohlc_cache
    from ml import refresh_ml_scores

    refresh_ml_scores(_ohlc_cache)


app = FastAPI(title="Pulsar", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Internal helpers ──────────────────────────────────────────────────────────


def _build_coin(raw: dict) -> dict:
    coin_id = raw["id"]
    ohlc = get_ohlc(coin_id)
    indics = compute_indicators(ohlc) if ohlc else None
    change_7d = raw.get("price_change_percentage_7d_in_currency") or 0.0
    sig = compute_signal(indics, change_7d)

    price_history_7d: list[float] = []
    if ohlc:
        price_history_7d = [c[4] for c in sorted(ohlc, key=lambda c: c[0])[-7:]]

    return {
        "id": coin_id,
        "symbol": raw["symbol"],
        "name": raw["name"],
        "image": raw.get("image"),
        "price": raw["current_price"],
        "market_cap": raw["market_cap"],
        "market_cap_rank": raw["market_cap_rank"],
        "volume_24h": raw["total_volume"],
        "change_24h": raw.get("price_change_percentage_24h") or 0.0,
        "change_7d": change_7d,
        "price_history_7d": price_history_7d,
        "indicators": indics,
        "signal": sig["signal"],
        "signal_reasons": sig["reasons"],
    }


def _composite(signal_score: float, ml_score) -> tuple[float, str, str]:
    score = signal_score * 0.6 + ml_score * 0.4 if ml_score is not None else float(signal_score)
    if score >= 60:
        return score, "buy", "Buy"
    if score >= 40:
        return score, "hold", "Hold"
    return score, "sell", "Sell"


def _market_score(fg_value: int, coins_cache: dict) -> dict:
    """
    Overall market score (0–100):
      Fear & Greed 40% | Advancing ratio 25% | BTC dom trend 20% | Avg 24h 15%
    """
    reasons: list[str] = []
    coins = list(coins_cache.values())

    # Fear & Greed (40%)
    if fg_value <= 20:
        fg_score = 72
        reasons.append(f"Extreme fear ({fg_value}) — contrarian buy signal")
    elif fg_value <= 40:
        fg_score = 62
        reasons.append(f"Fear at {fg_value} — depressed sentiment")
    elif fg_value <= 60:
        fg_score = 50
        reasons.append(f"Neutral sentiment at {fg_value}")
    elif fg_value <= 80:
        fg_score = 35
        reasons.append(f"Greed at {fg_value} — elevated risk")
    else:
        fg_score = 22
        reasons.append(f"Extreme greed ({fg_value}) — caution warranted")

    # Advancing / declining ratio (25%)
    changes_24h = [c.get("price_change_percentage_24h") or 0.0 for c in coins]
    total = len(changes_24h) or 1
    advancing = sum(1 for ch in changes_24h if ch > 0)
    adv_ratio = advancing / total
    adv_score = adv_ratio * 100
    if adv_ratio >= 0.7:
        reasons.append(f"Broad advance — {advancing}/{total} coins up today")
    elif adv_ratio <= 0.3:
        reasons.append(f"Broad decline — only {advancing}/{total} coins up today")

    # BTC dominance trend proxy (20%)
    changes_7d = [c.get("price_change_percentage_7d_in_currency") or 0.0 for c in coins]
    avg_7d = sum(changes_7d) / len(changes_7d) if changes_7d else 0.0
    btc_7d = coins_cache.get("bitcoin", {}).get("price_change_percentage_7d_in_currency") or 0.0
    btc_dom_delta = btc_7d - avg_7d
    if btc_dom_delta > 5:
        dom_score = 32
        reasons.append("BTC outperforming — defensive rotation")
    elif btc_dom_delta >= 0:
        dom_score = 45
    elif btc_dom_delta > -5:
        dom_score = 55
    else:
        dom_score = 65
        reasons.append("BTC underperforming — risk-on altcoin sentiment")

    # Avg 24h change (15%)
    avg_24h = sum(changes_24h) / total
    if avg_24h > 5:
        momentum_score = 72
        reasons.append(f"Strong momentum (+{avg_24h:.1f}% avg 24h)")
    elif avg_24h > 2:
        momentum_score = 62
    elif avg_24h >= 0:
        momentum_score = 53
    elif avg_24h > -2:
        momentum_score = 47
    elif avg_24h > -5:
        momentum_score = 38
        reasons.append(f"Negative momentum ({avg_24h:.1f}% avg 24h)")
    else:
        momentum_score = 28
        reasons.append(f"Broad sell-off ({avg_24h:.1f}% avg 24h)")

    score = round(fg_score * 0.40 + adv_score * 0.25 + dom_score * 0.20 + momentum_score * 0.15)
    score = max(0, min(100, score))

    if score >= 60:
        verdict, label = "buy", "Buy"
    elif score >= 40:
        verdict, label = "neutral", "Neutral"
    elif score >= 20:
        verdict, label = "caution", "Cautious"
    else:
        verdict, label = "sell", "Sell"

    return {"score": score, "verdict": verdict, "verdict_label": label, "reasons": reasons[:3]}


def _fg_interpretation(value: int, trend: int) -> str:
    if value >= 75:
        base = "The market is in extreme greed territory."
    elif value >= 55:
        base = "The market is showing greed."
    elif value >= 45:
        base = "Sentiment is roughly neutral."
    elif value >= 25:
        base = "The market is showing fear."
    else:
        base = "The market is in extreme fear territory."

    if trend > 10:
        ctx = " Sentiment has risen sharply over the past week — historically a warning sign."
    elif trend > 3:
        ctx = " Sentiment has been creeping higher — watch for overextension."
    elif trend < -10:
        ctx = " Sentiment has dropped sharply — could indicate capitulation."
    elif trend < -3:
        ctx = " Sentiment is fading — market confidence is softening."
    else:
        ctx = " Sentiment has been relatively stable."

    return base + ctx


def _portfolio_response(username: str, pf_name: str = "default") -> dict:
    portfolio = load_portfolio(username, pf_name)
    coins_cache, _ = get_coins_cache()
    nok_rate = get_nok_rate()
    holdings_list = []
    total_held = 0.0

    for coin_id, h in portfolio["holdings"].items():
        coin = coins_cache.get(coin_id, {})
        price = coin.get("current_price") or h["avg_buy_price"]
        value = h["amount"] * price
        pnl = value - h["amount"] * h["avg_buy_price"]
        pnl_pct = (price - h["avg_buy_price"]) / h["avg_buy_price"] * 100
        holdings_list.append(
            {
                "coin_id": coin_id,
                "symbol": coin.get("symbol", coin_id),
                "name": coin.get("name", coin_id),
                "image": coin.get("image"),
                "amount": h["amount"],
                "avg_buy_price": h["avg_buy_price"],
                "current_price": price,
                "value": round(value, 2),
                "value_nok": round(value * nok_rate, 2),
                "pnl": round(pnl, 2),
                "pnl_nok": round(pnl * nok_rate, 2),
                "pnl_pct": round(pnl_pct, 2),
            }
        )
        total_held += value

    total_value = portfolio["cash"] + total_held
    # Backward compat: old portfolios use initial_cash instead of total_deposited/total_withdrawn
    total_deposited = portfolio.get("total_deposited", portfolio.get("initial_cash", 0.0))
    total_withdrawn = portfolio.get("total_withdrawn", 0.0)
    net_invested = total_deposited - total_withdrawn
    total_pnl = total_value - net_invested
    total_pnl_pct = (total_pnl / net_invested * 100) if net_invested > 0 else 0.0

    record_snapshot(username, total_value, portfolio["cash"], total_pnl_pct, pf_name)

    return {
        "portfolio_name": pf_name,
        "cash": round(portfolio["cash"], 2),
        "cash_nok": round(portfolio["cash"] * nok_rate, 2),
        "total_deposited": round(total_deposited, 2),
        "total_withdrawn": round(total_withdrawn, 2),
        "net_invested": round(net_invested, 2),
        "holdings": holdings_list,
        "total_value": round(total_value, 2),
        "total_value_nok": round(total_value * nok_rate, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_nok": round(total_pnl * nok_rate, 2),
        "total_pnl_pct": round(total_pnl_pct, 2),
        "nok_rate": round(nok_rate, 4),
        "transactions": list(reversed(portfolio["transactions"])),
    }


# ── Auth routes ───────────────────────────────────────────────────────────────


@app.post("/api/auth/login")
def api_login(body: dict):
    user = authenticate(body.get("username", ""), body.get("password", ""))
    if user is None:
        raise HTTPException(401, "Invalid credentials")
    token = create_token(user["username"], user["is_admin"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": user["username"],
        "is_admin": user["is_admin"],
    }


@app.get("/api/auth/users")
def api_list_users(admin: dict = Depends(require_admin)):
    return list_users()


@app.post("/api/auth/users")
def api_create_user(body: dict, admin: dict = Depends(require_admin)):
    username = body.get("username", "").strip()
    password = body.get("password", "")
    if not username or not password:
        raise HTTPException(400, "username and password are required")
    try:
        return create_user(username, password, admin["username"])
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.delete("/api/auth/users/{username}")
def api_delete_user(username: str, admin: dict = Depends(require_admin)):
    if not delete_user(username):
        raise HTTPException(404, f"User '{username}' not found or cannot be deleted")
    return {"deleted": username}


# ── Public market routes ──────────────────────────────────────────────────────


@app.get("/api/coins")
def api_coins():
    cache, ts = get_coins_cache()
    if not cache:
        raise HTTPException(503, "Coin data not yet available")
    return {
        "updated_at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
        "coins": [_build_coin(raw) for raw in cache.values()],
    }


@app.get("/api/market")
def api_market():
    cache, _ = get_coins_cache()
    if not cache:
        raise HTTPException(503, "Coin data not yet available")
    coins = list(cache.values())
    total_mc = sum(c.get("market_cap") or 0 for c in coins)
    total_vol = sum(c.get("total_volume") or 0 for c in coins)
    btc = cache.get("bitcoin", {})
    eth = cache.get("ethereum", {})
    btc_dom = round((btc.get("market_cap") or 0) / total_mc * 100, 1) if total_mc else 0
    eth_dom = round((eth.get("market_cap") or 0) / total_mc * 100, 1) if total_mc else 0
    changes = [c.get("price_change_percentage_24h") or 0.0 for c in coins]
    return {
        "total_market_cap": total_mc,
        "total_volume_24h": total_vol,
        "btc_dominance": btc_dom,
        "eth_dominance": eth_dom,
        "avg_change_24h": round(sum(changes) / len(changes), 2) if changes else 0.0,
        "advancing": sum(1 for ch in changes if ch > 0),
        "declining": sum(1 for ch in changes if ch < 0),
    }


@app.get("/api/feargreed")
async def api_feargreed():
    cache, ts = get_feargreed_cache()
    if not cache:
        await refresh_feargreed()
        cache, ts = get_feargreed_cache()
    if not cache:
        raise HTTPException(503, "Fear & Greed data not available")
    pts = cache.get("data", [])
    if not pts:
        raise HTTPException(503, "Fear & Greed data empty")
    value = int(pts[0]["value"])
    yesterday = int(pts[1]["value"]) if len(pts) > 1 else value
    last_week = int(pts[6]["value"]) if len(pts) > 6 else value
    history = [
        {
            "date": dp.get("timestamp", ""),
            "value": int(dp["value"]),
            "classification": dp["value_classification"],
        }
        for dp in pts
    ]
    coins_cache, _ = get_coins_cache()
    return {
        "value": value,
        "classification": pts[0]["value_classification"],
        "yesterday": yesterday,
        "last_week": last_week,
        "trend": value - yesterday,
        "history": history,
        "interpretation": _fg_interpretation(value, value - last_week),
        "market_score": _market_score(value, coins_cache),
    }


@app.get("/api/history/{coin_id}")
def api_history(coin_id: str):
    ohlc = get_ohlc(coin_id)
    if ohlc is None:
        raise HTTPException(404, f"No history for {coin_id}")
    data = [
        {
            "date": datetime.fromtimestamp(c[0] / 1000, tz=timezone.utc).date().isoformat(),
            "open": c[1],
            "high": c[2],
            "low": c[3],
            "close": c[4],
        }
        for c in ohlc
    ]
    return {"coin_id": coin_id, "days": 14, "data": data}


@app.get("/api/signals")
def api_signals():
    cache, ts = get_coins_cache()
    if not cache:
        raise HTTPException(503, "Coin data not yet available")
    signals = []
    for coin_id, raw in cache.items():
        ohlc = get_ohlc(coin_id)
        indics = compute_indicators(ohlc) if ohlc else None
        change_7d = raw.get("price_change_percentage_7d_in_currency") or 0.0
        sig = compute_signal(indics, change_7d)
        ml = get_ml_score(coin_id)
        comp, verdict, label = _composite(sig["signal_score"], ml)
        signals.append(
            {
                "coin_id": coin_id,
                "symbol": raw["symbol"],
                "signal": sig["signal"],
                "signal_score": sig["signal_score"],
                "ml_score": ml,
                "composite_score": round(comp, 1),
                "composite_verdict": verdict,
                "composite_label": label,
                "reasons": sig["reasons"],
            }
        )
    return {
        "updated_at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
        "signals": signals,
    }


@app.get("/api/news")
async def api_news():
    news, ts = get_news_cache()
    if not news:
        await refresh_news()
        news, ts = get_news_cache()
    return {
        "news": news,
        "updated_at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None,
    }


@app.get("/api/backtest/{coin_id}")
def api_backtest(coin_id: str):
    ohlc = get_ohlc(coin_id)
    if ohlc is None:
        raise HTTPException(404, f"No OHLC data for {coin_id}")
    return run_backtest(ohlc)


# ── Watchlist routes ──────────────────────────────────────────────────────────


@app.get("/api/watchlist")
def api_watchlist_get(user: dict = Depends(get_current_user)):
    return load_watchlist(user["username"])


@app.post("/api/watchlist/{coin_id}")
def api_watchlist_add(coin_id: str, user: dict = Depends(get_current_user)):
    return wl_add(user["username"], coin_id)


@app.delete("/api/watchlist/{coin_id}")
def api_watchlist_remove(coin_id: str, user: dict = Depends(get_current_user)):
    return wl_remove(user["username"], coin_id)


# ── Portfolio management routes ───────────────────────────────────────────────


@app.get("/api/portfolios")
def api_list_portfolios(user: dict = Depends(get_current_user)):
    return list_portfolios(user["username"])


@app.post("/api/portfolios")
def api_create_portfolio(body: dict, user: dict = Depends(get_current_user)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Portfolio name is required")
    try:
        create_portfolio(user["username"], name)
        return {"created": name}
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.delete("/api/portfolios/{name}")
def api_delete_portfolio(name: str, user: dict = Depends(get_current_user)):
    try:
        delete_portfolio(user["username"], name)
        return {"deleted": name}
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))


# ── Protected portfolio routes ────────────────────────────────────────────────


@app.get("/api/portfolio")
def api_portfolio(
    user: dict = Depends(get_current_user),
    portfolio: str = Query("default"),
):
    return _portfolio_response(user["username"], portfolio)


@app.get("/api/portfolio/history")
def api_portfolio_history(
    user: dict = Depends(get_current_user),
    portfolio: str = Query("default"),
):
    return load_history(user["username"], portfolio)


@app.post("/api/portfolio/buy")
def api_portfolio_buy(body: dict, user: dict = Depends(get_current_user)):
    coin_id = body.get("coin_id")
    usd_amount = float(body.get("usd_amount", 0))
    pf_name = body.get("portfolio", "default")
    if usd_amount < 1:
        raise HTTPException(400, "Minimum trade is $1")
    price = get_coin_price(coin_id)
    if price is None:
        raise HTTPException(404, f"Unknown coin: {coin_id}")
    pf = load_portfolio(user["username"], pf_name)
    if usd_amount > pf["cash"]:
        raise HTTPException(400, "Insufficient cash")
    amount = usd_amount / price
    h = pf["holdings"].get(coin_id)
    if h:
        new_total = h["amount"] + amount
        h["avg_buy_price"] = (h["amount"] * h["avg_buy_price"] + amount * price) / new_total
        h["amount"] = new_total
    else:
        pf["holdings"][coin_id] = {"amount": amount, "avg_buy_price": price}
    pf["cash"] -= usd_amount
    pf["transactions"].append(
        {
            "id": f"txn_{len(pf['transactions']) + 1:04d}",
            "type": "buy",
            "coin_id": coin_id,
            "amount": amount,
            "price": price,
            "total": usd_amount,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        }
    )
    save_portfolio(user["username"], pf, pf_name)
    return _portfolio_response(user["username"], pf_name)


@app.post("/api/portfolio/sell")
def api_portfolio_sell(body: dict, user: dict = Depends(get_current_user)):
    coin_id = body.get("coin_id")
    usd_amount = float(body.get("usd_amount", 0))
    pf_name = body.get("portfolio", "default")
    if usd_amount < 1:
        raise HTTPException(400, "Minimum trade is $1")
    price = get_coin_price(coin_id)
    if price is None:
        raise HTTPException(404, f"Unknown coin: {coin_id}")
    pf = load_portfolio(user["username"], pf_name)
    h = pf["holdings"].get(coin_id)
    if not h:
        raise HTTPException(400, f"No holding for {coin_id}")
    if usd_amount > h["amount"] * price:
        raise HTTPException(400, "Cannot sell more than current holding value")
    sell_amount = usd_amount / price
    h["amount"] -= sell_amount
    if h["amount"] < 1e-10:
        del pf["holdings"][coin_id]
    pf["cash"] += usd_amount
    pf["transactions"].append(
        {
            "id": f"txn_{len(pf['transactions']) + 1:04d}",
            "type": "sell",
            "coin_id": coin_id,
            "amount": sell_amount,
            "price": price,
            "total": usd_amount,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        }
    )
    save_portfolio(user["username"], pf, pf_name)
    return _portfolio_response(user["username"], pf_name)


@app.post("/api/portfolio/reset")
def api_portfolio_reset(
    user: dict = Depends(get_current_user),
    portfolio: str = Query("default"),
):
    reset_portfolio(user["username"], portfolio)
    return _portfolio_response(user["username"], portfolio)


@app.post("/api/portfolio/deposit")
def api_portfolio_deposit(body: dict, user: dict = Depends(get_current_user)):
    amount = float(body.get("amount", 0))
    pf_name = body.get("portfolio", "default")
    if amount <= 0:
        raise HTTPException(400, "Amount must be positive")
    pf = load_portfolio(user["username"], pf_name)
    pf["cash"] += amount
    pf["total_deposited"] = pf.get("total_deposited", pf.get("initial_cash", 0.0)) + amount
    pf["transactions"].append(
        {
            "id": f"txn_{len(pf['transactions']) + 1:04d}",
            "type": "deposit",
            "total": amount,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        }
    )
    save_portfolio(user["username"], pf, pf_name)
    return _portfolio_response(user["username"], pf_name)


@app.post("/api/portfolio/withdraw")
def api_portfolio_withdraw(body: dict, user: dict = Depends(get_current_user)):
    amount = float(body.get("amount", 0))
    pf_name = body.get("portfolio", "default")
    if amount <= 0:
        raise HTTPException(400, "Amount must be positive")
    pf = load_portfolio(user["username"], pf_name)
    if amount > pf["cash"]:
        raise HTTPException(400, "Insufficient cash to withdraw")
    pf["cash"] -= amount
    pf["total_withdrawn"] = pf.get("total_withdrawn", 0.0) + amount
    pf["transactions"].append(
        {
            "id": f"txn_{len(pf['transactions']) + 1:04d}",
            "type": "withdrawal",
            "total": amount,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        }
    )
    save_portfolio(user["username"], pf, pf_name)
    return _portfolio_response(user["username"], pf_name)


@app.get("/api/portfolio/recommendation")
def api_portfolio_recommendation(
    user: dict = Depends(get_current_user),
    portfolio: str = Query("default"),
):
    pf = load_portfolio(user["username"], portfolio)
    coins_cache, _ = get_coins_cache()
    signals: dict = {}
    for coin_id, raw in coins_cache.items():
        ohlc = get_ohlc(coin_id)
        indics = compute_indicators(ohlc) if ohlc else None
        change_7d = raw.get("price_change_percentage_7d_in_currency") or 0.0
        sig = compute_signal(indics, change_7d)
        ml = get_ml_score(coin_id)
        comp, verdict, _label = _composite(sig["signal_score"], ml)
        signals[coin_id] = {
            "composite_score": round(comp, 1),
            "composite_verdict": verdict,
        }
    total_held = sum(
        h["amount"] * (coins_cache.get(cid, {}).get("current_price") or h["avg_buy_price"])
        for cid, h in pf["holdings"].items()
    )
    total_value = pf["cash"] + total_held
    return recommend(pf, coins_cache, signals, total_value)


# Serve the frontend — mounted last so /api/* routes always take priority
_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.is_dir():
    app.mount("/", StaticFiles(directory=_frontend, html=True), name="frontend")
