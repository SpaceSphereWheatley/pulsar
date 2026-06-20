// Plain-language portfolio recommendation engine. Direct port of
// server/recommendation.py — verified against migration/fixtures/recommendation.json.

import { pyround } from "./series.js";
import { c0, c2, f0, f1 } from "./pyfmt.js";

const MAX_POSITION_PCT = 0.2;
const MIN_TRADE_USD = 10.0;

// ── Indicator plain-language helpers ─────────────────────────────────────────

export function rsiLabel(rsi) {
  if (rsi === null || rsi === undefined) return "";
  if (rsi < 30) return `Oversold — may bounce (${f0(rsi)})`;
  if (rsi < 45) return `Below average (${f0(rsi)})`;
  if (rsi < 55) return `Neutral (${f0(rsi)})`;
  if (rsi < 70) return `Healthy (${f0(rsi)})`;
  return `Overbought — watch out (${f0(rsi)})`;
}

export function macdLabel(hist) {
  if (hist === null || hist === undefined) return "";
  if (hist > 50) return "Strong uptrend";
  if (hist > 0) return "Mild uptrend";
  if (hist > -50) return "Mild downtrend";
  return "Strong downtrend";
}

export function bbLabel(pos) {
  if (pos === null || pos === undefined) return "";
  const pct = pos * 100;
  if (pct < 20) return `Near support (${f0(pct)}%)`;
  if (pct < 40) return `Lower range (${f0(pct)}%)`;
  if (pct < 60) return `Mid-range (${f0(pct)}%)`;
  if (pct < 80) return `Upper range (${f0(pct)}%)`;
  return `Near resistance (${f0(pct)}%)`;
}

export function indicatorLabels(indicators) {
  if (!indicators) return { rsi: "", macd: "", bb: "" };
  return {
    rsi: rsiLabel(indicators.rsi),
    macd: macdLabel(indicators.macd_histogram),
    bb: bbLabel(indicators.bb_position),
  };
}

// ── Recommendation engine ─────────────────────────────────────────────────────

export function recommend(portfolio, coinsCache, signals, totalValue) {
  const recs = [];
  const cash = portfolio.cash;
  const holdings = portfolio.holdings || {};

  // Held positions
  for (const [coinId, h] of Object.entries(holdings)) {
    const coin = coinsCache[coinId] || {};
    const price = coin.current_price || h.avg_buy_price;
    const currentValue = h.amount * price;
    const pnlPct = ((price - h.avg_buy_price) / h.avg_buy_price) * 100;
    const positionPct = totalValue ? (currentValue / totalValue) * 100 : 0;

    const sig = signals[coinId] || {};
    const compScore = sig.composite_score ?? 50;
    const symbol = (coin.symbol || coinId).toUpperCase();
    const name = coin.name || coinId;

    let action = "hold";
    let suggestedUsd = null;
    let plain = "";
    let detail = "";

    if (compScore < 35) {
      if (pnlPct >= 5) {
        action = "sell";
        suggestedUsd = pyround(currentValue * 0.5, 2);
        plain = `Consider taking some ${symbol} profits — you're up ${f1(pnlPct)}% and the signal has turned bearish.`;
        detail = `Selling around $${c0(suggestedUsd)} (half your position) locks in gains. You can always buy back lower.`;
      } else if (pnlPct <= -12) {
        action = "sell";
        suggestedUsd = pyround(currentValue * 0.5, 2);
        plain = `${symbol} is down ${f1(Math.abs(pnlPct))}% and still signalling weakness. Reducing your position limits further losses.`;
        detail = `Selling $${c0(suggestedUsd)} cuts your exposure in half. The signal score is ${f0(compScore)}/100 — not a good outlook.`;
      } else {
        action = "hold";
        plain = `Hold your ${symbol}. The signal is weak but you're near breakeven — no urgency to sell.`;
        detail = `Signal score is ${f0(compScore)}/100. Wait for a clearer direction before acting.`;
      }
    } else if (compScore >= 60) {
      const targetValue = totalValue * MAX_POSITION_PCT;
      const room = Math.max(0.0, targetValue - currentValue);
      const affordable = Math.min(room, cash * 0.3);

      if (affordable >= MIN_TRADE_USD && cash >= MIN_TRADE_USD) {
        action = "buy";
        suggestedUsd = pyround(affordable, 2);
        plain = `${name} is looking strong. Adding about $${c0(suggestedUsd)} makes sense here.`;
        const projected = Math.min(positionPct + (suggestedUsd / totalValue) * 100, 20);
        detail = `Signal score is ${f0(compScore)}/100. That would bring ${symbol} to roughly ${f0(projected)}% of your portfolio — a healthy allocation.`;
      } else {
        action = "hold";
        plain = `${name} looks good but you're low on cash. Hold what you have.`;
        detail = `Signal score is ${f0(compScore)}/100, but you only have $${c2(cash)} free. No room to add right now.`;
      }
    } else {
      action = "hold";
      plain = `Hold your ${symbol} — signals are mixed and there's no clear reason to buy or sell.`;
      detail = `Signal score is ${f0(compScore)}/100. The market is undecided on ${name}.`;
    }

    recs.push({
      coin_id: coinId,
      symbol,
      name,
      action,
      plain,
      detail,
      suggested_usd: suggestedUsd,
      current_value: pyround(currentValue, 2),
      pnl_pct: pyround(pnlPct, 2),
      position_pct: pyround(positionPct, 1),
      composite_score: pyround(compScore, 1),
    });
  }

  // Opportunities in coins you don't hold
  if (cash >= 50) {
    for (const [coinId, sig] of Object.entries(signals)) {
      if (coinId in holdings) continue;
      const compScore = sig.composite_score ?? 50;
      if (compScore < 70) continue;
      const coin = coinsCache[coinId] || {};
      const symbol = (coin.symbol || coinId).toUpperCase();
      const name = coin.name || coinId;
      const suggestedUsd = pyround(Math.min(totalValue * 0.08, cash * 0.25), 2);
      if (suggestedUsd < MIN_TRADE_USD) continue;
      recs.push({
        coin_id: coinId,
        symbol,
        name,
        action: "buy",
        plain: `${name} is showing a strong buy signal and you don't own any. Worth considering a small position.`,
        detail: `Signal score ${f0(compScore)}/100. Starting with $${c0(suggestedUsd)} would be about ${f0((suggestedUsd / totalValue) * 100)}% of your portfolio — low risk to try.`,
        suggested_usd: suggestedUsd,
        current_value: 0.0,
        pnl_pct: 0.0,
        position_pct: 0.0,
        composite_score: pyround(compScore, 1),
      });
    }
  }

  // Overall summary
  const nBuy = recs.filter((r) => r.action === "buy").length;
  const nSell = recs.filter((r) => r.action === "sell").length;
  const totalDeposited = portfolio.total_deposited ?? portfolio.initial_cash ?? 0.0;
  const netInvested = totalDeposited - (portfolio.total_withdrawn ?? 0.0);
  const totalPnlPct = netInvested ? ((totalValue - netInvested) / netInvested) * 100 : 0;
  const cashPct = totalValue ? (cash / totalValue) * 100 : 100;

  const hasHoldings = Object.keys(holdings).length > 0;
  let summary;
  if (!hasHoldings) {
    if (nBuy > 0) {
      summary = `You're holding $${c0(cash)} in cash. There ${nBuy > 1 ? "are" : "is"} ${nBuy} buy signal${nBuy > 1 ? "s" : ""} worth looking at.`;
    } else {
      summary = `You have $${c0(cash)} in cash. Signals are quiet right now — no rush to deploy.`;
    }
  } else if (totalPnlPct >= 0) {
    const pnlStr = `up ${f1(totalPnlPct)}%`;
    if (nBuy > 0 && nSell > 0) {
      summary = `Portfolio is ${pnlStr}. ${nBuy} position${nBuy > 1 ? "s" : ""} to add to, ${nSell} to trim.`;
    } else if (nBuy > 0) {
      summary = `Portfolio is ${pnlStr}. ${nBuy > 1 ? "A few" : "One"} opportunity to add — signals are leaning bullish.`;
    } else if (nSell > 0) {
      summary = `Portfolio is ${pnlStr}. Consider taking some profits — ${nSell > 1 ? "a few positions are" : "one position is"} showing sell signals.`;
    } else {
      summary = `Portfolio is ${pnlStr} and all signals say hold. Nothing to do right now.`;
    }
  } else {
    const pnlStr = `down ${f1(Math.abs(totalPnlPct))}%`;
    if (nSell > 0) {
      summary = `Portfolio is ${pnlStr}. Cutting the flagged ${nSell > 1 ? "positions" : "position"} could stop further losses.`;
    } else {
      summary = `Portfolio is ${pnlStr}, but signals suggest holding. Markets recover — no panic selling needed.`;
    }
  }

  return { summary, recommendations: recs, cash_pct: pyround(cashPct, 1) };
}
