// RSI-14, MACD(12,26,9), Bollinger Bands(20,2σ) and the weighted signal score.
// Direct port of server/indicators.py — verified against migration/fixtures.
//
// OHLC candle shape: [ts_ms, open, high, low, close].

import {
  clipLower,
  clipUpper,
  diff,
  ewm,
  pyround,
  rollingMean,
  rollingStd,
  safe,
} from "./series.js";

// _close_series: require >=30 candles, sort by ts ascending, return closes.
function closeSeries(ohlc) {
  if (!ohlc || ohlc.length < 30) return null;
  const sorted = [...ohlc].sort((a, b) => a[0] - b[0]);
  return sorted.map((c) => Number(c[4]));
}

// _rsi: Wilder smoothing (com=13, min_periods=14). Returns the last value.
function rsiSeries(close, period = 14) {
  const delta = diff(close);
  const gain = clipLower(delta, 0);
  const loss = clipUpper(delta, 0).map((v) => (Number.isNaN(v) ? NaN : -v));
  const avgGain = ewm(gain, { com: period - 1, minPeriods: period });
  const avgLoss = ewm(loss, { com: period - 1, minPeriods: period });
  return avgGain.map((g, i) => {
    const l = avgLoss[i];
    const rs = g / l; // NaN or Inf propagate; safe() maps them to null
    return 100.0 - 100.0 / (1.0 + rs);
  });
}

// _macd: EMA spans 12/26/9 (adjust=False, no min_periods). Returns series.
function macdSeries(close, fast = 12, slow = 26, signal = 9) {
  const emaFast = ewm(close, { span: fast });
  const emaSlow = ewm(close, { span: slow });
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ewm(macdLine, { span: signal });
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// _bbands: SMA20 ± 2·std(ddof=1). Returns upper/lower series.
function bbandsSeries(close, period = 20, stdDev = 2.0) {
  const sma = rollingMean(close, period);
  const std = rollingStd(close, period, 1);
  const upper = sma.map((m, i) => m + stdDev * std[i]);
  const lower = sma.map((m, i) => m - stdDev * std[i]);
  return { upper, lower };
}

// Public: last-value indicators dict, or null when <30 candles. Mirrors
// indicators.compute_indicators exactly (including the bb_position fallback).
export function computeIndicators(ohlc) {
  const close = closeSeries(ohlc);
  if (close === null) return null;

  const last = (arr) => safe(arr[arr.length - 1]);

  const rsi = last(rsiSeries(close));
  const { macdLine, signalLine, histogram } = macdSeries(close);
  const macd = last(macdLine);
  const macdSignal = last(signalLine);
  const macdHistogram = last(histogram);

  const { upper, lower } = bbandsSeries(close);
  const bbUpper = last(upper);
  const bbLower = last(lower);
  const price = safe(close[close.length - 1]);

  let bbPosition = null;
  if (bbUpper !== null && bbLower !== null && price !== null) {
    const range = bbUpper - bbLower;
    bbPosition = range > 0 ? (price - bbLower) / range : 0.5;
  }

  return {
    rsi,
    macd,
    macd_signal: macdSignal,
    macd_histogram: macdHistogram,
    bb_upper: bbUpper,
    bb_lower: bbLower,
    bb_position: bbPosition,
  };
}

// Python f-string helpers reproduced for byte-identical "reasons" strings.
const fix1 = (x) => x.toFixed(1); // {:.1f}
const signed1 = (x) => (x >= 0 ? "+" : "") + x.toFixed(1); // {:+.1f}
const pct0 = (x) => `${Math.round(x * 100)}%`; // {:.0%} (banker's rounding diff is negligible here)

// Public: weighted signal score → label. Mirrors indicators.compute_signal.
export function computeSignal(indicators, change7d) {
  if (indicators === null || indicators === undefined) {
    return { signal: "neutral", signal_score: 50, reasons: ["Insufficient historical data"] };
  }

  const reasons = [];
  let weighted = 0.0;
  let weightSum = 0.0;

  // RSI (35%)
  const rsi = indicators.rsi;
  if (rsi !== null && rsi !== undefined) {
    let rsiScore;
    let note;
    if (rsi < 30) {
      rsiScore = 85;
      note = `RSI oversold (${fix1(rsi)}) — potential reversal`;
    } else if (rsi > 70) {
      rsiScore = 15;
      note = `RSI overbought (${fix1(rsi)}) — elevated risk`;
    } else if (rsi < 45) {
      rsiScore = 63;
      note = `RSI recovering (${fix1(rsi)})`;
    } else if (rsi > 55) {
      rsiScore = 37;
      note = `RSI elevated (${fix1(rsi)})`;
    } else {
      rsiScore = 50;
      note = `RSI neutral (${fix1(rsi)})`;
    }
    reasons.push(note);
    weighted += rsiScore * 0.35;
    weightSum += 0.35;
  }

  // MACD (35%)
  const macd = indicators.macd;
  const macdSig = indicators.macd_signal;
  const macdHist = indicators.macd_histogram;
  if (macd !== null && macd !== undefined && macdSig !== null && macdSig !== undefined && macdHist !== null && macdHist !== undefined) {
    let macdScore;
    let note;
    if (macd > macdSig && macdHist > 0) {
      macdScore = 75;
      note = "MACD bullish — above signal line";
    } else if (macd < macdSig && macdHist < 0) {
      macdScore = 25;
      note = "MACD bearish — below signal line";
    } else {
      macdScore = 50;
      note = "MACD near signal line";
    }
    reasons.push(note);
    weighted += macdScore * 0.35;
    weightSum += 0.35;
  }

  // Bollinger position (20%)
  const bbPos = indicators.bb_position;
  if (bbPos !== null && bbPos !== undefined) {
    const bbScore = Math.max(10.0, Math.min(90.0, 80.0 - 60.0 * bbPos));
    if (bbPos < 0.2) reasons.push("Price near lower Bollinger Band — potential bounce");
    else if (bbPos > 0.8) reasons.push("Price near upper Bollinger Band — potential resistance");
    else reasons.push(`Price at ${pct0(bbPos)} of Bollinger range`);
    weighted += bbScore * 0.2;
    weightSum += 0.2;
  }

  // 7-day trend (10%)
  let trendScore;
  let trendNote;
  if (change7d > 10) {
    trendScore = 72;
    trendNote = `Strong 7d gain (${signed1(change7d)}%)`;
  } else if (change7d > 3) {
    trendScore = 60;
    trendNote = `Positive 7d trend (${signed1(change7d)}%)`;
  } else if (change7d < -10) {
    trendScore = 28;
    trendNote = `Sharp 7d decline (${signed1(change7d)}%)`;
  } else if (change7d < -3) {
    trendScore = 40;
    trendNote = `Negative 7d trend (${signed1(change7d)}%)`;
  } else {
    trendScore = 50;
    trendNote = `Flat 7d trend (${signed1(change7d)}%)`;
  }
  reasons.push(trendNote);
  weighted += trendScore * 0.1;
  weightSum += 0.1;

  const signalScore = weightSum ? weighted / weightSum : 50.0;

  let signal;
  if (signalScore >= 75) signal = "strong_buy";
  else if (signalScore >= 60) signal = "buy";
  else if (signalScore >= 40) signal = "neutral";
  else if (signalScore >= 25) signal = "caution";
  else signal = "sell";

  return { signal, signal_score: pyround(signalScore, 1), reasons };
}
