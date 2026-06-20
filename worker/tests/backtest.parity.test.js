// Phase 2 parity gate: JS backtest aggregates must match the Python fixture.
// This is an end-to-end check: it exercises computeIndicators + computeSignal in
// a loop, so agreement here confirms the whole signal pipeline composes correctly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runBacktest } from "../backtest.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(resolve(here, "../../migration/fixtures/backtest.json"), "utf8"),
);

function expectStatsEqual(js, py, label) {
  expect(js.count, `${label}.count`).toBe(py.count);
  for (const k of ["win_rate", "avg_return"]) {
    if (py[k] === null) expect(js[k], `${label}.${k}`).toBeNull();
    else expect(Math.abs(js[k] - py[k]), `${label}.${k} ${js[k]} vs ${py[k]}`).toBeLessThan(1e-9);
  }
}

describe("backtest parity", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`${name}: aggregate stats and records match pandas pipeline`, () => {
      const js = runBacktest(fx.ohlc);
      const py = fx.result;
      expect(js.forward_days).toBe(py.forward_days);
      expect(js.total_signals, `${name}.total_signals`).toBe(py.total_signals);
      expectStatsEqual(js.buy, py.buy, `${name}.buy`);
      expectStatsEqual(js.sell, py.sell, `${name}.sell`);
      expectStatsEqual(js.hold, py.hold, `${name}.hold`);
      expect(js.recent.length, `${name}.recent length`).toBe(py.recent.length);
      for (let i = 0; i < py.recent.length; i++) {
        const a = js.recent[i];
        const b = py.recent[i];
        expect(a.date, `${name}.recent[${i}].date`).toBe(b.date);
        expect(a.signal, `${name}.recent[${i}].signal`).toBe(b.signal);
        expect(Math.abs(a.signal_score - b.signal_score), `${name}.recent[${i}].score`).toBeLessThan(1e-9);
        expect(Math.abs(a.entry_price - b.entry_price), `${name}.recent[${i}].entry`).toBeLessThan(1e-9);
        expect(Math.abs(a.fwd_return - b.fwd_return), `${name}.recent[${i}].fwd`).toBeLessThan(1e-9);
      }
    });
  }
});
