// Per-coin ML scoring — a hand-rolled Ridge regression that reproduces the
// scikit-learn pipeline in server/ml.py (StandardScaler → Ridge(alpha=1.0) with
// fit_intercept). Verified against migration/fixtures/ml.json.
//
// Feature engineering note: ml.py's RSI uses ewm(com=13) WITHOUT min_periods
// (so it warms up from index 0, unlike indicators.py's RSI) and guards
// divide-by-zero with .replace(0, NaN). We mirror that exactly here.

import { diff, ewm, pctChange, pyround, rollingMean, rollingStd, shift } from "./series.js";

const isNum = (v) => v !== null && v !== undefined && typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);

// Replicates ml._build_dataset. Returns { X, y, xPred } (X: rows×4, y: rows,
// xPred: 1×4) or null when there is insufficient data (<40 candles or <10
// trainable rows).
export function buildDataset(ohlc) {
  if (!ohlc || ohlc.length < 40) return null;

  const sorted = [...ohlc].sort((a, b) => a[0] - b[0]);
  const close = sorted.map((c) => Number(c[4]));
  const n = close.length;

  // RSI-14 (Wilder com=13, no min_periods), with avg_loss==0 → NaN guard.
  const delta = diff(close);
  const gain = delta.map((v) => (Number.isNaN(v) ? NaN : Math.max(v, 0)));
  const loss = delta.map((v) => (Number.isNaN(v) ? NaN : Math.max(-v, 0)));
  const avgGain = ewm(gain, { com: 13 });
  const avgLossRaw = ewm(loss, { com: 13 });
  const avgLoss = avgLossRaw.map((v) => (v === 0 ? NaN : v)); // .replace(0, nan)
  const rsi = avgGain.map((g, i) => {
    const rs = g / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });

  // MACD histogram (12/26/9).
  const ema12 = ewm(close, { span: 12 });
  const ema26 = ewm(close, { span: 26 });
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ewm(macdLine, { span: 9 });
  const macdHist = macdLine.map((v, i) => v - signalLine[i]);

  // Bollinger position (20, 2σ) with band_width==0 → NaN guard.
  const bbMid = rollingMean(close, 20);
  const bbStd = rollingStd(close, 20, 1);
  const bbPos = close.map((c, i) => {
    const width = 4 * bbStd[i];
    const w = width === 0 ? NaN : width;
    return (c - (bbMid[i] - 2 * bbStd[i])) / w;
  });

  // 7-day lookback return (%) and forward 7-day target (%).
  const ret7 = pctChange(close, 7).map((v) => (Number.isNaN(v) ? NaN : v * 100));
  const fwdClose = shift(close, -7);
  const fwd7 = close.map((c, i) => (isNum(fwdClose[i]) && c !== 0 ? (fwdClose[i] / c - 1) * 100 : NaN));

  // feat row i = [rsi, macd_hist, bb_pos, ret7]; valid = all four + fwd7 present.
  const feat = [];
  for (let i = 0; i < n; i++) feat.push([rsi[i], macdHist[i], bbPos[i], ret7[i]]);
  const rowValid = feat.map((r) => r.every(isNum));

  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    // train_mask = valid & fwd7.notna() & (index < n - 7)
    if (rowValid[i] && isNum(fwd7[i]) && i < n - 7) {
      X.push(feat[i].slice());
      y.push(fwd7[i]);
    }
  }
  if (X.length < 10) return null;

  // pred_idx = last index where all four features are present (feat.dropna()).
  let predIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (rowValid[i]) {
      predIdx = i;
      break;
    }
  }
  if (predIdx < 0) return null;
  const xPred = [feat[predIdx].slice()];

  return { X, y, xPred };
}

// ── Linear algebra (small, dense) ─────────────────────────────────────────────

// Solve A·x = b for a square A via Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-15) continue; // singular column; leave as 0
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / pv;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const d = M[i][i];
    x[i] = Math.abs(d) < 1e-15 ? 0 : M[i][n] / d;
  }
  return x;
}

// ── StandardScaler (population std, zeros→1) ──────────────────────────────────

function fitScaler(X) {
  const nRows = X.length;
  const nCols = X[0].length;
  const mean = new Array(nCols).fill(0);
  const scale = new Array(nCols).fill(0);
  for (let c = 0; c < nCols; c++) {
    let s = 0;
    for (let r = 0; r < nRows; r++) s += X[r][c];
    mean[c] = s / nRows;
  }
  for (let c = 0; c < nCols; c++) {
    let v = 0;
    for (let r = 0; r < nRows; r++) {
      const d = X[r][c] - mean[c];
      v += d * d;
    }
    v /= nRows; // ddof=0, population variance (np.var / sklearn default)
    const std = Math.sqrt(v);
    scale[c] = std === 0 ? 1.0 : std; // _handle_zeros_in_scale
  }
  return { mean, scale };
}

function applyScaler({ mean, scale }, X) {
  return X.map((row) => row.map((v, c) => (v - mean[c]) / scale[c]));
}

// ── Ridge(alpha, fit_intercept=True) via Cholesky-style normal equations ──────
// Mirrors sklearn: center X and y, solve (Xc·Xcᵀ + αI)·w = Xcᵀ·yc, then
// intercept = ȳ − X̄·w. predict(x) = x·w + intercept.

function fitRidge(X, y, alpha = 1.0) {
  const nRows = X.length;
  const nCols = X[0].length;
  const xMean = new Array(nCols).fill(0);
  for (let c = 0; c < nCols; c++) {
    let s = 0;
    for (let r = 0; r < nRows; r++) s += X[r][c];
    xMean[c] = s / nRows;
  }
  const yMean = y.reduce((a, b) => a + b, 0) / nRows;
  const Xc = X.map((row) => row.map((v, c) => v - xMean[c]));
  const yc = y.map((v) => v - yMean);

  // Normal equations: A = Xcᵀ·Xc + αI ; bvec = Xcᵀ·yc
  const A = Array.from({ length: nCols }, () => new Array(nCols).fill(0));
  const bvec = new Array(nCols).fill(0);
  for (let i = 0; i < nCols; i++) {
    for (let j = 0; j < nCols; j++) {
      let s = 0;
      for (let r = 0; r < nRows; r++) s += Xc[r][i] * Xc[r][j];
      A[i][j] = s + (i === j ? alpha : 0);
    }
    let sb = 0;
    for (let r = 0; r < nRows; r++) sb += Xc[r][i] * yc[r];
    bvec[i] = sb;
  }
  const coef = solveLinear(A, bvec);
  let intercept = yMean;
  for (let c = 0; c < nCols; c++) intercept -= xMean[c] * coef[c];
  return { coef, intercept };
}

function predictRidge({ coef, intercept }, X) {
  return X.map((row) => row.reduce((acc, v, c) => acc + v * coef[c], intercept));
}

// Full per-coin score: returns { score, quality } (both 0–100, 1 decimal) or
// { score: null, quality: null } when the dataset can't be built.
export function scoreCoin(ohlc) {
  const ds = buildDataset(ohlc);
  if (ds === null) return { score: null, quality: null };
  const { X, y, xPred } = ds;

  const scaler = fitScaler(X);
  const Xs = applyScaler(scaler, X);
  const xs = applyScaler(scaler, xPred);

  const model = fitRidge(Xs, y, 1.0);
  const pred = predictRidge(model, xs)[0];

  // score = percentile rank of pred among training targets, clamped 0–100.
  const below = y.filter((v) => v < pred).length;
  let score = pyround((below / y.length) * 100, 1);
  score = Math.max(0.0, Math.min(100.0, score));

  // quality = in-sample directional hit-rate (sign match), 1 decimal.
  const yPred = predictRidge(model, Xs);
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const hits = yPred.filter((p, i) => sign(p) === sign(y[i])).length;
  const quality = pyround((hits / y.length) * 100, 1);

  return { score, quality };
}

// Batch refresh over an OHLC cache map { coin_id: ohlc[] } → { coin_id: {score,quality} }.
export function refreshMlScores(ohlcByCoin) {
  const out = {};
  for (const [coinId, ohlc] of Object.entries(ohlcByCoin)) {
    const { score, quality } = scoreCoin(ohlc);
    if (score !== null) out[coinId] = { score, quality };
  }
  return out;
}
