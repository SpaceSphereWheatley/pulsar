// Phase 2 parity gate: the hand-rolled JS indicators must reproduce the Python
// (pandas) ground truth captured in migration/fixtures/indicators.json — both at
// the full-series level and the public last-value contract, plus signal output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { computeIndicators, computeSignal } from "../indicators.js";
import {
  clipLower,
  clipUpper,
  diff,
  ewm,
  rollingMean,
  rollingStd,
  safe,
} from "../series.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(resolve(here, "../../migration/fixtures/indicators.json"), "utf8"),
);

const TOL = 1e-6;

// Compare a JS series (NaN/Inf as numbers) to a Python series (nulls), applying
// safe() to the JS side so NaN/Inf both collapse to null like Python's _safe.
function expectSeriesClose(jsRaw, py, label) {
  expect(jsRaw.length, `${label} length`).toBe(py.length);
  for (let i = 0; i < py.length; i++) {
    const j = safe(jsRaw[i]);
    if (py[i] === null) {
      expect(j, `${label}[${i}] expected null`).toBeNull();
    } else {
      expect(j, `${label}[${i}] expected non-null`).not.toBeNull();
      expect(Math.abs(j - py[i]), `${label}[${i}] = ${j} vs ${py[i]}`).toBeLessThan(TOL);
    }
  }
}

// Recompute full JS series the same way indicators.js does internally, for
// series-level parity against the Python fixture's `series` block.
function jsSeries(ohlc) {
  if (!ohlc || ohlc.length < 30) return null;
  const close = [...ohlc].sort((a, b) => a[0] - b[0]).map((c) => Number(c[4]));
  const delta = diff(close);
  const gain = clipLower(delta, 0);
  const loss = clipUpper(delta, 0).map((v) => (Number.isNaN(v) ? NaN : -v));
  const avgGain = ewm(gain, { com: 13, minPeriods: 14 });
  const avgLoss = ewm(loss, { com: 13, minPeriods: 14 });
  const rsi = avgGain.map((g, i) => 100 - 100 / (1 + g / avgLoss[i]));
  const emaFast = ewm(close, { span: 12 });
  const emaSlow = ewm(close, { span: 26 });
  const macd = emaFast.map((v, i) => v - emaSlow[i]);
  const macdSignal = ewm(macd, { span: 9 });
  const macdHistogram = macd.map((v, i) => v - macdSignal[i]);
  const sma = rollingMean(close, 20);
  const std = rollingStd(close, 20, 1);
  const bbUpper = sma.map((m, i) => m + 2 * std[i]);
  const bbLower = sma.map((m, i) => m - 2 * std[i]);
  return { close_sorted: close, rsi, macd, macd_signal: macdSignal, macd_histogram: macdHistogram, bb_upper: bbUpper, bb_lower: bbLower };
}

describe("indicators series parity", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    if (fx.series === null) continue;
    it(`${name}: full RSI/MACD/BB series match pandas`, () => {
      const js = jsSeries(fx.ohlc);
      for (const key of Object.keys(fx.series)) {
        expectSeriesClose(js[key], fx.series[key], `${name}.${key}`);
      }
    });
  }
});

describe("computeIndicators public contract", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`${name}: last-value indicators match`, () => {
      const js = computeIndicators(fx.ohlc);
      if (fx.indicators === null) {
        expect(js).toBeNull();
        return;
      }
      for (const key of Object.keys(fx.indicators)) {
        const py = fx.indicators[key];
        if (py === null) expect(js[key], `${name}.${key}`).toBeNull();
        else {
          expect(js[key], `${name}.${key} non-null`).not.toBeNull();
          expect(Math.abs(js[key] - py), `${name}.${key} ${js[key]} vs ${py}`).toBeLessThan(TOL);
        }
      }
    });
  }
});

describe("computeSignal parity", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    for (const [chg, pySig] of Object.entries(fx.signals)) {
      it(`${name} @ change_7d=${chg}: signal label/score/reasons match`, () => {
        const change = Number(chg);
        const js = computeSignal(fx.indicators, change);
        expect(js.signal, `${name}@${chg} label`).toBe(pySig.signal);
        expect(Math.abs(js.signal_score - pySig.signal_score), `${name}@${chg} score`).toBeLessThan(1e-9);
        expect(js.reasons, `${name}@${chg} reasons`).toEqual(pySig.reasons);
      });
    }
  }
});
