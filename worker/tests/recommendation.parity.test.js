// Phase 2 parity gate: JS recommend() must reproduce recommendation.py's output
// — actions, suggested amounts, rounded numerics, and the exact plain-language
// strings (which depend on Python-style number formatting) — across scenarios
// covering every branch (sell-profit, sell-loss, hold-breakeven, add-position,
// low-cash, opportunities, and each summary variant).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { recommend } from "../recommendation.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(resolve(here, "../../migration/fixtures/recommendation.json"), "utf8"),
);

describe("recommendation parity", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`${name}: summary, actions, amounts and strings match Python`, () => {
      const js = recommend(fx.portfolio, fx.coins_cache, fx.signals, fx.total_value);
      const py = fx.result;

      expect(js.summary, `${name}.summary`).toBe(py.summary);
      expect(Math.abs(js.cash_pct - py.cash_pct), `${name}.cash_pct`).toBeLessThan(1e-9);
      expect(js.recommendations.length, `${name}.recs length`).toBe(py.recommendations.length);

      for (let i = 0; i < py.recommendations.length; i++) {
        const a = js.recommendations[i];
        const b = py.recommendations[i];
        const L = `${name}.rec[${i}]`;
        expect(a.coin_id, `${L}.coin_id`).toBe(b.coin_id);
        expect(a.symbol, `${L}.symbol`).toBe(b.symbol);
        expect(a.name, `${L}.name`).toBe(b.name);
        expect(a.action, `${L}.action`).toBe(b.action);
        expect(a.plain, `${L}.plain`).toBe(b.plain);
        expect(a.detail, `${L}.detail`).toBe(b.detail);
        if (b.suggested_usd === null) expect(a.suggested_usd, `${L}.suggested_usd`).toBeNull();
        else expect(Math.abs(a.suggested_usd - b.suggested_usd), `${L}.suggested_usd`).toBeLessThan(1e-9);
        for (const k of ["current_value", "pnl_pct", "position_pct", "composite_score"]) {
          expect(Math.abs(a[k] - b[k]), `${L}.${k} ${a[k]} vs ${b[k]}`).toBeLessThan(1e-9);
        }
      }
    });
  }
});
