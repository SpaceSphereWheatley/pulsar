"""Plain-language portfolio recommendation engine."""

from __future__ import annotations

from typing import Optional

_MAX_POSITION_PCT = 0.20  # target ceiling: 20% of portfolio in one coin
_MIN_TRADE_USD = 10.0


# ── Indicator plain-language helpers ─────────────────────────────────────────


def rsi_label(rsi: Optional[float]) -> str:
    if rsi is None:
        return ""
    if rsi < 30:
        return f"Oversold — may bounce ({rsi:.0f})"
    if rsi < 45:
        return f"Below average ({rsi:.0f})"
    if rsi < 55:
        return f"Neutral ({rsi:.0f})"
    if rsi < 70:
        return f"Healthy ({rsi:.0f})"
    return f"Overbought — watch out ({rsi:.0f})"


def macd_label(hist: Optional[float]) -> str:
    if hist is None:
        return ""
    if hist > 50:
        return "Strong uptrend"
    if hist > 0:
        return "Mild uptrend"
    if hist > -50:
        return "Mild downtrend"
    return "Strong downtrend"


def bb_label(pos: Optional[float]) -> str:
    if pos is None:
        return ""
    pct = pos * 100
    if pct < 20:
        return f"Near support ({pct:.0f}%)"
    if pct < 40:
        return f"Lower range ({pct:.0f}%)"
    if pct < 60:
        return f"Mid-range ({pct:.0f}%)"
    if pct < 80:
        return f"Upper range ({pct:.0f}%)"
    return f"Near resistance ({pct:.0f}%)"


def indicator_labels(indicators: Optional[dict]) -> dict:
    if not indicators:
        return {"rsi": "", "macd": "", "bb": ""}
    return {
        "rsi": rsi_label(indicators.get("rsi")),
        "macd": macd_label(indicators.get("macd_histogram")),
        "bb": bb_label(indicators.get("bb_position")),
    }


# ── Recommendation engine ─────────────────────────────────────────────────────


def recommend(
    portfolio: dict,
    coins_cache: dict,
    signals: dict,
    total_value: float,
) -> dict:
    """
    Return plain-English buy/sell/hold recommendations with suggested USD amounts.

    signals: coin_id → {composite_score, composite_verdict, ...}
    """
    recs: list[dict] = []
    cash = portfolio["cash"]
    holdings = portfolio["holdings"]

    # ── Held positions ────────────────────────────────────────────────────────
    for coin_id, h in holdings.items():
        coin = coins_cache.get(coin_id, {})
        price = coin.get("current_price") or h["avg_buy_price"]
        current_value = h["amount"] * price
        pnl_pct = (price - h["avg_buy_price"]) / h["avg_buy_price"] * 100
        position_pct = current_value / total_value * 100 if total_value else 0

        sig = signals.get(coin_id, {})
        comp_score = sig.get("composite_score", 50)
        symbol = coin.get("symbol", coin_id).upper()
        name = coin.get("name", coin_id)

        action = "hold"
        suggested_usd: Optional[float] = None
        plain = ""
        detail = ""

        if comp_score < 35:
            if pnl_pct >= 5:
                action = "sell"
                suggested_usd = round(current_value * 0.5, 2)
                plain = f"Consider taking some {symbol} profits — you're up {pnl_pct:.1f}% and the signal has turned bearish."
                detail = f"Selling around ${suggested_usd:,.0f} (half your position) locks in gains. You can always buy back lower."
            elif pnl_pct <= -12:
                action = "sell"
                suggested_usd = round(current_value * 0.5, 2)
                plain = f"{symbol} is down {abs(pnl_pct):.1f}% and still signalling weakness. Reducing your position limits further losses."
                detail = f"Selling ${suggested_usd:,.0f} cuts your exposure in half. The signal score is {comp_score:.0f}/100 — not a good outlook."
            else:
                action = "hold"
                plain = f"Hold your {symbol}. The signal is weak but you're near breakeven — no urgency to sell."
                detail = f"Signal score is {comp_score:.0f}/100. Wait for a clearer direction before acting."

        elif comp_score >= 60:
            target_value = total_value * _MAX_POSITION_PCT
            room = max(0.0, target_value - current_value)
            affordable = min(room, cash * 0.3)

            if affordable >= _MIN_TRADE_USD and cash >= _MIN_TRADE_USD:
                action = "buy"
                suggested_usd = round(affordable, 2)
                plain = f"{name} is looking strong. Adding about ${suggested_usd:,.0f} makes sense here."
                detail = (
                    f"Signal score is {comp_score:.0f}/100. "
                    f"That would bring {symbol} to roughly "
                    f"{min(position_pct + suggested_usd / total_value * 100, 20):.0f}% of your portfolio — a healthy allocation."
                )
            else:
                action = "hold"
                plain = f"{name} looks good but you're low on cash. Hold what you have."
                detail = f"Signal score is {comp_score:.0f}/100, but you only have ${cash:,.2f} free. No room to add right now."

        else:
            action = "hold"
            plain = f"Hold your {symbol} — signals are mixed and there's no clear reason to buy or sell."
            detail = f"Signal score is {comp_score:.0f}/100. The market is undecided on {name}."

        recs.append(
            {
                "coin_id": coin_id,
                "symbol": symbol,
                "name": name,
                "action": action,
                "plain": plain,
                "detail": detail,
                "suggested_usd": suggested_usd,
                "current_value": round(current_value, 2),
                "pnl_pct": round(pnl_pct, 2),
                "position_pct": round(position_pct, 1),
                "composite_score": round(comp_score, 1),
            }
        )

    # ── Opportunities in coins you don't hold ─────────────────────────────────
    if cash >= 50:
        for coin_id, sig in signals.items():
            if coin_id in holdings:
                continue
            comp_score = sig.get("composite_score", 50)
            if comp_score < 70:
                continue
            coin = coins_cache.get(coin_id, {})
            symbol = coin.get("symbol", coin_id).upper()
            name = coin.get("name", coin_id)
            suggested_usd = round(min(total_value * 0.08, cash * 0.25), 2)
            if suggested_usd < _MIN_TRADE_USD:
                continue
            recs.append(
                {
                    "coin_id": coin_id,
                    "symbol": symbol,
                    "name": name,
                    "action": "buy",
                    "plain": f"{name} is showing a strong buy signal and you don't own any. Worth considering a small position.",
                    "detail": (
                        f"Signal score {comp_score:.0f}/100. "
                        f"Starting with ${suggested_usd:,.0f} would be about "
                        f"{suggested_usd / total_value * 100:.0f}% of your portfolio — low risk to try."
                    ),
                    "suggested_usd": suggested_usd,
                    "current_value": 0.0,
                    "pnl_pct": 0.0,
                    "position_pct": 0.0,
                    "composite_score": round(comp_score, 1),
                }
            )

    # ── Overall summary ───────────────────────────────────────────────────────
    n_buy = sum(1 for r in recs if r["action"] == "buy")
    n_sell = sum(1 for r in recs if r["action"] == "sell")
    # P&L is measured against net invested capital (deposits − withdrawals),
    # matching _portfolio_response. Fall back to the legacy initial_cash field
    # only for old portfolios that predate the deposit/withdraw model.
    total_deposited = portfolio.get("total_deposited", portfolio.get("initial_cash", 0.0))
    net_invested = total_deposited - portfolio.get("total_withdrawn", 0.0)
    total_pnl_pct = (total_value - net_invested) / net_invested * 100 if net_invested else 0
    cash_pct = cash / total_value * 100 if total_value else 100

    if not holdings:
        if n_buy > 0:
            summary = f"You're holding ${cash:,.0f} in cash. There {'are' if n_buy > 1 else 'is'} {n_buy} buy signal{'s' if n_buy > 1 else ''} worth looking at."
        else:
            summary = (
                f"You have ${cash:,.0f} in cash. Signals are quiet right now — no rush to deploy."
            )
    elif total_pnl_pct >= 0:
        pnl_str = f"up {total_pnl_pct:.1f}%"
        if n_buy > 0 and n_sell > 0:
            summary = f"Portfolio is {pnl_str}. {n_buy} position{'s' if n_buy > 1 else ''} to add to, {n_sell} to trim."
        elif n_buy > 0:
            summary = f"Portfolio is {pnl_str}. {'A few' if n_buy > 1 else 'One'} opportunity to add — signals are leaning bullish."
        elif n_sell > 0:
            summary = f"Portfolio is {pnl_str}. Consider taking some profits — {'a few positions are' if n_sell > 1 else 'one position is'} showing sell signals."
        else:
            summary = f"Portfolio is {pnl_str} and all signals say hold. Nothing to do right now."
    else:
        pnl_str = f"down {abs(total_pnl_pct):.1f}%"
        if n_sell > 0:
            summary = f"Portfolio is {pnl_str}. Cutting the flagged {'positions' if n_sell > 1 else 'position'} could stop further losses."
        else:
            summary = f"Portfolio is {pnl_str}, but signals suggest holding. Markets recover — no panic selling needed."

    return {
        "summary": summary,
        "recommendations": recs,
        "cash_pct": round(cash_pct, 1),
    }
