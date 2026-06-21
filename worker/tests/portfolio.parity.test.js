// Phase 6 parity gate: a deterministic deposit/buy/buy/buy/sell/withdraw sequence
// is replayed against the Worker and checked against the Python ground truth
// (migration/generate_portfolio_fixture.py), catching any drift in cumulative
// floating-point arithmetic (avg_buy_price, net_invested, total_pnl_pct) that
// single-call tests wouldn't surface.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { call, login, setupEnv } from "./helpers/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../migration/fixtures/portfolio.json"), "utf8"),
);

const NUMERIC_FIELDS = [
  "cash",
  "cash_nok",
  "total_deposited",
  "total_withdrawn",
  "net_invested",
  "total_value",
  "total_value_nok",
  "total_pnl",
  "total_pnl_nok",
  "total_pnl_pct",
  "nok_rate",
];

const HOLDING_NUMERIC_FIELDS = ["amount", "avg_buy_price", "current_price", "value", "value_nok", "pnl", "pnl_nok", "pnl_pct"];

function expectClose(actual, expected, label) {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThan(1e-6);
}

function expectPortfolioEqual(js, py, label) {
  expect(js.portfolio_name, `${label}.portfolio_name`).toBe(py.portfolio_name);
  for (const f of NUMERIC_FIELDS) expectClose(js[f], py[f], `${label}.${f}`);

  expect(js.holdings.length, `${label}.holdings.length`).toBe(py.holdings.length);
  const jsByCoid = Object.fromEntries(js.holdings.map((h) => [h.coin_id, h]));
  for (const ph of py.holdings) {
    const jh = jsByCoid[ph.coin_id];
    expect(jh, `${label}.holdings[${ph.coin_id}]`).toBeDefined();
    for (const f of HOLDING_NUMERIC_FIELDS) expectClose(jh[f], ph[f], `${label}.holdings[${ph.coin_id}].${f}`);
  }

  expect(js.transactions.length, `${label}.transactions.length`).toBe(py.transactions.length);
  for (let i = 0; i < py.transactions.length; i++) {
    const jt = js.transactions[i];
    const pt = py.transactions[i];
    expect(jt.id, `${label}.transactions[${i}].id`).toBe(pt.id);
    expect(jt.type, `${label}.transactions[${i}].type`).toBe(pt.type);
    if (pt.coin_id !== undefined) expect(jt.coin_id, `${label}.transactions[${i}].coin_id`).toBe(pt.coin_id);
    for (const f of ["amount", "price", "total"]) {
      if (pt[f] !== undefined && pt[f] !== null) expectClose(jt[f], pt[f], `${label}.transactions[${i}].${f}`);
    }
  }
}

describe("portfolio cross-implementation parity", () => {
  it("matches Python ground truth after a deposit/buy/buy/buy/sell/withdraw sequence", async () => {
    const env = await setupEnv();
    const token = await login(env);

    const actions = { deposit: "deposit", buy: "buy", sell: "sell", withdraw: "withdraw" };
    let lastResponse;
    for (let i = 0; i < fixture.sequence.length; i++) {
      const [action, body] = fixture.sequence[i];
      const r = await call(env, "POST", `/api/portfolio/${actions[action]}`, { token, body });
      const pyStep = fixture.steps[i];
      expect(r.status, `step ${i} (${action}) status`).toBe(pyStep.status);
      expectPortfolioEqual(r.body, pyStep.response, `step ${i} (${action})`);
      lastResponse = r.body;
    }

    const final = await call(env, "GET", "/api/portfolio", { token });
    expect(final.status).toBe(200);
    expectPortfolioEqual(final.body, fixture.final, "final");
    expectPortfolioEqual(lastResponse, fixture.final, "lastStep-vs-final");
  });
});
