// Market + portfolio response helpers — ports of the inline helpers in main.py
// (_build_coin, _composite, _market_score, _fg_interpretation,
// _portfolio_response, and the signals builder). All read from D1 caches.

import { computeIndicators, computeSignal } from "./indicators.js";
import { pyround } from "./series.js";
import { f1 } from "./pyfmt.js";
import {
  getCoinsCache,
  getMlScores,
  getNokRate,
  getOhlc,
  loadPortfolioObj,
} from "./db.js";

// _build_coin
export async function buildCoin(env, raw) {
  const coinId = raw.id;
  const ohlc = await getOhlc(env, coinId);
  const indics = ohlc ? computeIndicators(ohlc) : null;
  const change7d = raw.price_change_percentage_7d_in_currency || 0.0;
  const sig = computeSignal(indics, change7d);

  let priceHistory7d = [];
  if (ohlc) {
    priceHistory7d = [...ohlc].sort((a, b) => a[0] - b[0]).slice(-7).map((c) => c[4]);
  }

  return {
    id: coinId,
    symbol: raw.symbol,
    name: raw.name,
    image: raw.image ?? null,
    price: raw.current_price,
    market_cap: raw.market_cap,
    market_cap_rank: raw.market_cap_rank,
    volume_24h: raw.total_volume,
    change_24h: raw.price_change_percentage_24h || 0.0,
    change_7d: change7d,
    price_history_7d: priceHistory7d,
    indicators: indics,
    signal: sig.signal,
    signal_reasons: sig.reasons,
  };
}

// _composite — 60% technical / 40% ML, with verdict label.
export function composite(signalScore, mlScore) {
  const score = mlScore !== null && mlScore !== undefined ? signalScore * 0.6 + mlScore * 0.4 : Number(signalScore);
  if (score >= 60) return [score, "buy", "Buy"];
  if (score >= 40) return [score, "hold", "Hold"];
  return [score, "sell", "Sell"];
}

// _market_score — overall 0–100 market sentiment with up to 3 reasons.
export function marketScore(fgValue, coinsCache) {
  const reasons = [];
  const coins = Object.values(coinsCache);

  // Fear & Greed (40%)
  let fgScore;
  if (fgValue <= 20) {
    fgScore = 72;
    reasons.push(`Extreme fear (${fgValue}) — contrarian buy signal`);
  } else if (fgValue <= 40) {
    fgScore = 62;
    reasons.push(`Fear at ${fgValue} — depressed sentiment`);
  } else if (fgValue <= 60) {
    fgScore = 50;
    reasons.push(`Neutral sentiment at ${fgValue}`);
  } else if (fgValue <= 80) {
    fgScore = 35;
    reasons.push(`Greed at ${fgValue} — elevated risk`);
  } else {
    fgScore = 22;
    reasons.push(`Extreme greed (${fgValue}) — caution warranted`);
  }

  // Advancing / declining (25%)
  const changes24h = coins.map((c) => c.price_change_percentage_24h || 0.0);
  const total = changes24h.length || 1;
  const advancing = changes24h.filter((ch) => ch > 0).length;
  const advRatio = advancing / total;
  const advScore = advRatio * 100;
  if (advRatio >= 0.7) reasons.push(`Broad advance — ${advancing}/${total} coins up today`);
  else if (advRatio <= 0.3) reasons.push(`Broad decline — only ${advancing}/${total} coins up today`);

  // BTC dominance trend proxy (20%)
  const changes7d = coins.map((c) => c.price_change_percentage_7d_in_currency || 0.0);
  const avg7d = changes7d.length ? changes7d.reduce((a, b) => a + b, 0) / changes7d.length : 0.0;
  const btc7d = coinsCache.bitcoin?.price_change_percentage_7d_in_currency || 0.0;
  const btcDomDelta = btc7d - avg7d;
  let domScore;
  if (btcDomDelta > 5) {
    domScore = 32;
    reasons.push("BTC outperforming — defensive rotation");
  } else if (btcDomDelta >= 0) {
    domScore = 45;
  } else if (btcDomDelta > -5) {
    domScore = 55;
  } else {
    domScore = 65;
    reasons.push("BTC underperforming — risk-on altcoin sentiment");
  }

  // Avg 24h momentum (15%)
  const avg24h = changes24h.reduce((a, b) => a + b, 0) / total;
  let momentumScore;
  if (avg24h > 5) {
    momentumScore = 72;
    reasons.push(`Strong momentum (+${f1(avg24h)}% avg 24h)`);
  } else if (avg24h > 2) {
    momentumScore = 62;
  } else if (avg24h >= 0) {
    momentumScore = 53;
  } else if (avg24h > -2) {
    momentumScore = 47;
  } else if (avg24h > -5) {
    momentumScore = 38;
    reasons.push(`Negative momentum (${f1(avg24h)}% avg 24h)`);
  } else {
    momentumScore = 28;
    reasons.push(`Broad sell-off (${f1(avg24h)}% avg 24h)`);
  }

  let score = pyround(fgScore * 0.4 + advScore * 0.25 + domScore * 0.2 + momentumScore * 0.15, 0);
  score = Math.max(0, Math.min(100, score));

  let verdict;
  let label;
  if (score >= 60) [verdict, label] = ["buy", "Buy"];
  else if (score >= 40) [verdict, label] = ["neutral", "Neutral"];
  else if (score >= 20) [verdict, label] = ["caution", "Cautious"];
  else [verdict, label] = ["sell", "Sell"];

  return { score, verdict, verdict_label: label, reasons: reasons.slice(0, 3) };
}

// _fg_interpretation
export function fgInterpretation(value, trend) {
  let base;
  if (value >= 75) base = "The market is in extreme greed territory.";
  else if (value >= 55) base = "The market is showing greed.";
  else if (value >= 45) base = "Sentiment is roughly neutral.";
  else if (value >= 25) base = "The market is showing fear.";
  else base = "The market is in extreme fear territory.";

  let ctx;
  if (trend > 10) ctx = " Sentiment has risen sharply over the past week — historically a warning sign.";
  else if (trend > 3) ctx = " Sentiment has been creeping higher — watch for overextension.";
  else if (trend < -10) ctx = " Sentiment has dropped sharply — could indicate capitulation.";
  else if (trend < -3) ctx = " Sentiment is fading — market confidence is softening.";
  else ctx = " Sentiment has been relatively stable.";

  return base + ctx;
}

// _portfolio_response (read-only)
export async function portfolioResponse(env, username, pfName = "default") {
  const portfolio = await loadPortfolioObj(env, username, pfName);
  const { cache: coinsCache } = await getCoinsCache(env);
  const nokRate = await getNokRate(env);
  const holdingsList = [];
  let totalHeld = 0.0;

  for (const [coinId, h] of Object.entries(portfolio.holdings)) {
    const coin = coinsCache[coinId] || {};
    const price = coin.current_price || h.avg_buy_price;
    const value = h.amount * price;
    const pnl = value - h.amount * h.avg_buy_price;
    const pnlPct = ((price - h.avg_buy_price) / h.avg_buy_price) * 100;
    holdingsList.push({
      coin_id: coinId,
      symbol: coin.symbol ?? coinId,
      name: coin.name ?? coinId,
      image: coin.image ?? null,
      amount: h.amount,
      avg_buy_price: h.avg_buy_price,
      current_price: price,
      value: pyround(value, 2),
      value_nok: pyround(value * nokRate, 2),
      pnl: pyround(pnl, 2),
      pnl_nok: pyround(pnl * nokRate, 2),
      pnl_pct: pyround(pnlPct, 2),
    });
    totalHeld += value;
  }

  const totalValue = portfolio.cash + totalHeld;
  const totalDeposited = portfolio.total_deposited ?? portfolio.initial_cash ?? 0.0;
  const totalWithdrawn = portfolio.total_withdrawn ?? 0.0;
  const netInvested = totalDeposited - totalWithdrawn;
  const totalPnl = totalValue - netInvested;
  const totalPnlPct = netInvested > 0 ? (totalPnl / netInvested) * 100 : 0.0;

  return {
    portfolio_name: pfName,
    cash: pyround(portfolio.cash, 2),
    cash_nok: pyround(portfolio.cash * nokRate, 2),
    total_deposited: pyround(totalDeposited, 2),
    total_withdrawn: pyround(totalWithdrawn, 2),
    net_invested: pyround(netInvested, 2),
    holdings: holdingsList,
    total_value: pyround(totalValue, 2),
    total_value_nok: pyround(totalValue * nokRate, 2),
    total_pnl: pyround(totalPnl, 2),
    total_pnl_nok: pyround(totalPnl * nokRate, 2),
    total_pnl_pct: pyround(totalPnlPct, 2),
    nok_rate: pyround(nokRate, 4),
    transactions: [...portfolio.transactions].reverse(),
  };
}

// Build the signals map (coin_id → composite info) used by /api/signals and the
// recommendation route. `full` includes the per-coin detail for /api/signals.
export async function buildSignals(env, full = false) {
  const { cache, ts } = await getCoinsCache(env);
  const { scores, quality } = await getMlScores(env);
  const detailed = [];
  const compact = {};

  for (const [coinId, raw] of Object.entries(cache)) {
    const ohlc = await getOhlc(env, coinId);
    const indics = ohlc ? computeIndicators(ohlc) : null;
    const change7d = raw.price_change_percentage_7d_in_currency || 0.0;
    const sig = computeSignal(indics, change7d);
    const ml = scores[coinId] ?? null;
    const [comp, verdict, label] = composite(sig.signal_score, ml);
    compact[coinId] = { composite_score: pyround(comp, 1), composite_verdict: verdict };
    if (full) {
      detailed.push({
        coin_id: coinId,
        symbol: raw.symbol,
        signal: sig.signal,
        signal_score: sig.signal_score,
        ml_score: ml,
        ml_quality: quality[coinId] ?? null,
        composite_score: pyround(comp, 1),
        composite_verdict: verdict,
        composite_label: label,
        reasons: sig.reasons,
      });
    }
  }
  return { detailed, compact, ts };
}
