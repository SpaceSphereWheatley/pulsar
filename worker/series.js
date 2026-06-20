// Numeric series primitives — faithful ports of the pandas operations used by
// the original Python indicators.py / ml.py, so the hand-rolled JS indicators
// reproduce pandas output bit-for-bit (within float tolerance).
//
// NaN is represented as JS `null` on input and `NaN` internally; outputs use
// `null` for NaN/Inf to mirror Python's _safe() guard. Runs unmodified in both
// Node (tests) and the Cloudflare Worker runtime — no platform APIs.

const isNum = (v) => v !== null && v !== undefined && typeof v === "number" && !Number.isNaN(v);

// close.diff(): first element NaN, then x[i] - x[i-1].
export function diff(values) {
  const out = [NaN];
  for (let i = 1; i < values.length; i++) {
    out.push(isNum(values[i]) && isNum(values[i - 1]) ? values[i] - values[i - 1] : NaN);
  }
  return out;
}

// Series.clip(lower=0) / -clip(upper=0): gains and losses from a diff series.
export function clipLower(values, lower) {
  return values.map((v) => (Number.isNaN(v) ? NaN : Math.max(v, lower)));
}
export function clipUpper(values, upper) {
  return values.map((v) => (Number.isNaN(v) ? NaN : Math.min(v, upper)));
}

// close.pct_change(periods): (x[i] / x[i-periods]) - 1, NaN for the warmup.
export function pctChange(values, periods) {
  const out = new Array(values.length).fill(NaN);
  for (let i = periods; i < values.length; i++) {
    const prev = values[i - periods];
    if (isNum(values[i]) && isNum(prev) && prev !== 0) out[i] = values[i] / prev - 1;
  }
  return out;
}

// close.shift(periods): positive shifts down (lookback), negative shifts up
// (lookahead, used for the forward-return target). Vacated slots are NaN.
export function shift(values, periods) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const src = i - periods;
    if (src >= 0 && src < n) out[i] = values[i - periods];
  }
  return out;
}

// pandas ewm(...).mean() with adjust=False, ignore_na=False — a direct port of
// the pandas `ewma` C kernel (window_aggregations.pyx). Supports `com` or
// `span`, and `minPeriods` (the count of observations required before output
// becomes non-NaN). The constant-series guard (skip update when value unchanged)
// matches pandas and prevents float drift on flat inputs.
export function ewm(values, { com, span, minPeriods = 0 } = {}) {
  let alpha;
  if (com !== undefined) alpha = 1 / (1 + com);
  else if (span !== undefined) alpha = 2 / (span + 1);
  else throw new Error("ewm requires com or span");

  const oldWtFactor = 1 - alpha;
  const newWt = alpha; // adjust=False
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (n === 0) return out;

  let weightedAvg = values[0];
  let isObs = isNum(weightedAvg);
  let nobs = isObs ? 1 : 0;
  let oldWt = 1;
  out[0] = nobs >= minPeriods ? weightedAvg : NaN;

  for (let i = 1; i < n; i++) {
    const cur = values[i];
    isObs = isNum(cur);
    if (isObs) nobs += 1;
    if (!Number.isNaN(weightedAvg)) {
      // ignore_na=False → decay even on a missing observation.
      oldWt *= oldWtFactor;
      if (isObs) {
        if (weightedAvg !== cur) {
          weightedAvg = (oldWt * weightedAvg + newWt * cur) / (oldWt + newWt);
        }
        oldWt = 1; // adjust=False resets the running weight
      }
    } else if (isObs) {
      weightedAvg = cur;
    }
    out[i] = nobs >= minPeriods ? weightedAvg : NaN;
  }
  return out;
}

// rolling(window).mean(): mean over a trailing window, NaN until the window is
// full and NaN if any value in the window is NaN (pandas default min_periods).
export function rollingMean(values, window) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for (let i = window - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - window + 1; j <= i; j++) {
      if (!isNum(values[j])) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (ok) out[i] = sum / window;
  }
  return out;
}

// rolling(window).std(ddof=1): sample standard deviation over a trailing window.
export function rollingStd(values, window, ddof = 1) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for (let i = window - 1; i < n; i++) {
    let ok = true;
    const win = [];
    for (let j = i - window + 1; j <= i; j++) {
      if (!isNum(values[j])) {
        ok = false;
        break;
      }
      win.push(values[j]);
    }
    if (!ok) continue;
    const mean = win.reduce((a, b) => a + b, 0) / window;
    const sse = win.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    const denom = window - ddof;
    out[i] = denom > 0 ? Math.sqrt(sse / denom) : NaN;
  }
  return out;
}

// Mirror of indicators._safe(): NaN/Inf → null, else a finite float.
export function safe(v) {
  if (v === null || v === undefined) return null;
  const f = Number(v);
  return Number.isNaN(f) || !Number.isFinite(f) ? null : f;
}

// Reproduce Python's round(x, ndigits). Python correctly rounds the *true
// double value* to `ndigits` decimals. toFixed does the same correct rounding of
// the underlying double without the float error a `* 10**n` multiply introduces.
// The only divergence from Python is on an *exact* binary tie (value exactly
// X.XX5 representable in binary), where Python rounds half-to-even and toFixed
// rounds half-away-from-zero — such exact ties don't occur in float-derived
// market data, and Number() strips the trailing-zero string back to a number.
export function pyround(x, ndigits = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  return Number(x.toFixed(ndigits));
}
