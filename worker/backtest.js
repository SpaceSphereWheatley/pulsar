// Signal backtesting over historical OHLC. Direct port of server/backtest.py —
// walks candles, computes the signal using only data available at each point,
// and measures the realized forward return, aggregated by signal class.

import { computeIndicators, computeSignal } from "./indicators.js";
import { pyround } from "./series.js";

const FORWARD_DAYS = 7;
const MIN_HISTORY = 35;

function stats(returns) {
  if (returns.length === 0) return { count: 0, win_rate: null, avg_return: null };
  const wins = returns.filter((r) => r > 0).length;
  return {
    count: returns.length,
    win_rate: pyround((wins / returns.length) * 100, 1),
    avg_return: pyround(returns.reduce((a, b) => a + b, 0) / returns.length, 2),
  };
}

// UTC date in YYYY-MM-DD — mirrors datetime.fromtimestamp(ts/1000, utc).date().
function utcDate(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function runBacktest(ohlc, forwardDays = FORWARD_DAYS) {
  const candles = [...ohlc].sort((a, b) => a[0] - b[0]);
  const records = [];

  for (let i = MIN_HISTORY; i < candles.length - forwardDays; i++) {
    const indics = computeIndicators(candles.slice(0, i + 1));
    if (!indics) continue;
    const prev7Close = i >= 7 ? candles[i - 7][4] : candles[0][4];
    const currClose = candles[i][4];
    const change7d = prev7Close ? ((currClose - prev7Close) / prev7Close) * 100 : 0.0;

    const sig = computeSignal(indics, change7d);
    const entry = candles[i][4];
    const exit = candles[i + forwardDays][4];
    const fwdReturn = entry ? ((exit - entry) / entry) * 100 : 0.0;

    records.push({
      date: utcDate(candles[i][0]),
      signal: sig.signal,
      signal_score: pyround(sig.signal_score, 1),
      entry_price: pyround(entry, 2),
      fwd_return: pyround(fwdReturn, 2),
    });
  }

  const buyRet = records.filter((r) => r.signal === "buy" || r.signal === "strong_buy").map((r) => r.fwd_return);
  const sellRet = records.filter((r) => r.signal === "sell" || r.signal === "caution").map((r) => r.fwd_return);
  const holdRet = records.filter((r) => r.signal === "neutral").map((r) => r.fwd_return);

  return {
    forward_days: forwardDays,
    total_signals: records.length,
    buy: stats(buyRet),
    sell: stats(sellRet),
    hold: stats(holdRet),
    recent: records.slice(-30),
  };
}
