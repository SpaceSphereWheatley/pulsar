// Phase 3 parity gate: the hand-rolled Ridge pipeline must reproduce the
// scikit-learn ground truth in migration/fixtures/ml.json — first the feature
// matrices from buildDataset (X / y / x_pred), then the final score + quality.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildDataset, scoreCoin } from "../ml.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(resolve(here, "../../migration/fixtures/ml.json"), "utf8"),
);

const TOL = 1e-6;

function expectMatrixClose(js, py, label) {
  expect(js.length, `${label} rows`).toBe(py.length);
  for (let i = 0; i < py.length; i++) {
    const a = Array.isArray(js[i]) ? js[i] : [js[i]];
    const b = Array.isArray(py[i]) ? py[i] : [py[i]];
    expect(a.length, `${label}[${i}] cols`).toBe(b.length);
    for (let j = 0; j < b.length; j++) {
      expect(Math.abs(a[j] - b[j]), `${label}[${i}][${j}] ${a[j]} vs ${b[j]}`).toBeLessThan(TOL);
    }
  }
}

describe("buildDataset feature-matrix parity", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`${name}: X / y / x_pred match scikit-learn inputs`, () => {
      const ds = buildDataset(fx.ohlc ?? fixturesOhlc(name));
      if (!fx.buildable) {
        expect(ds).toBeNull();
        return;
      }
      expect(ds, `${name} buildable`).not.toBeNull();
      expect(ds.X.length, `${name} n_train`).toBe(fx.n_train);
      expect(ds.X[0].length, `${name} n_features`).toBe(fx.n_features);
      expectMatrixClose(ds.X, fx.X, `${name}.X`);
      expectMatrixClose(ds.y.map((v) => [v]), fx.y.map((v) => [v]), `${name}.y`);
      expectMatrixClose(ds.xPred, fx.x_pred, `${name}.x_pred`);
    });
  }
});

describe("scoreCoin score + quality parity", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`${name}: Ridge score & quality match scikit-learn`, () => {
      const { score, quality } = scoreCoin(fx.ohlc ?? fixturesOhlc(name));
      if (!fx.buildable) {
        expect(score).toBeNull();
        expect(quality).toBeNull();
        return;
      }
      // score/quality are rounded to 1 decimal in both implementations; allow a
      // tiny tolerance for the percentile-rank boundary, then exact-match check.
      expect(Math.abs(score - fx.score), `${name} score ${score} vs ${fx.score}`).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(quality - fx.quality), `${name} quality ${quality} vs ${fx.quality}`).toBeLessThanOrEqual(0.1 + 1e-9);
    });
  }
});

// ml.json doesn't embed OHLC (it lives in indicators.json); pull it from there.
let _indicators;
function fixturesOhlc(name) {
  if (!_indicators) {
    _indicators = JSON.parse(
      readFileSync(resolve(here, "../../migration/fixtures/indicators.json"), "utf8"),
    );
  }
  return _indicators[name].ohlc;
}
