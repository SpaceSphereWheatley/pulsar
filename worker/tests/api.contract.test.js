// Phase 4/6 route-contract gate: every endpoint from the FastAPI app, re-asserted
// against the Worker + D1 — status codes, response shapes, and auth enforcement.
// Mirrors server/tests/test_api.py.

import { beforeEach, describe, expect, it } from "vitest";
import { call, login, setupEnv } from "./helpers/app.js";

let env;
let token;
beforeEach(async () => {
  env = await setupEnv();
  token = await login(env);
});

describe("auth", () => {
  it("login returns a token and admin flag", async () => {
    const r = await call(env, "POST", "/api/auth/login", { body: { username: "admin", password: "admin" } });
    expect(r.status).toBe(200);
    expect(r.body.token_type).toBe("bearer");
    expect(r.body.is_admin).toBe(true);
    expect(typeof r.body.access_token).toBe("string");
  });

  it("login rejects bad credentials with 401", async () => {
    const r = await call(env, "POST", "/api/auth/login", { body: { username: "admin", password: "wrong" } });
    expect(r.status).toBe(401);
  });

  it("login with missing fields returns 422", async () => {
    const r = await call(env, "POST", "/api/auth/login", { body: { username: "admin" } });
    expect(r.status).toBe(422);
  });

  it("change password then log in with the new one", async () => {
    const r = await call(env, "POST", "/api/auth/password", {
      token,
      body: { current_password: "admin", new_password: "newpass123" },
    });
    expect(r.status).toBe(200);
    const relog = await call(env, "POST", "/api/auth/login", { body: { username: "admin", password: "newpass123" } });
    expect(relog.status).toBe(200);
  });

  it("admin can create, list, and delete a user", async () => {
    const create = await call(env, "POST", "/api/auth/users", { token, body: { username: "alice", password: "pw" } });
    expect(create.status).toBe(200);
    expect(create.body.is_admin).toBe(false);

    const list = await call(env, "GET", "/api/auth/users", { token });
    expect(list.status).toBe(200);
    expect(list.body.map((u) => u.username).sort()).toEqual(["admin", "alice"]);

    const dup = await call(env, "POST", "/api/auth/users", { token, body: { username: "alice", password: "pw" } });
    expect(dup.status).toBe(409);

    const del = await call(env, "DELETE", "/api/auth/users/alice", { token });
    expect(del.status).toBe(200);
  });

  it("admin account cannot be deleted", async () => {
    const r = await call(env, "DELETE", "/api/auth/users/admin", { token });
    expect(r.status).toBe(404);
  });

  it("non-admin cannot list users (403)", async () => {
    await call(env, "POST", "/api/auth/users", { token, body: { username: "bob", password: "pw" } });
    const bobToken = await login(env, "bob", "pw");
    const r = await call(env, "GET", "/api/auth/users", { token: bobToken });
    expect(r.status).toBe(403);
  });

  it("user routes require a token (401)", async () => {
    expect((await call(env, "GET", "/api/auth/users")).status).toBe(401);
    expect((await call(env, "GET", "/api/watchlist")).status).toBe(401);
  });
});

describe("market data", () => {
  it("health reports ok when coins cache is warm", async () => {
    const r = await call(env, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("coins returns built coin objects with indicators + signal", async () => {
    const r = await call(env, "GET", "/api/coins");
    expect(r.status).toBe(200);
    expect(r.body.coins).toHaveLength(2);
    const btc = r.body.coins.find((c) => c.id === "bitcoin");
    expect(btc.symbol).toBe("btc");
    expect(btc.price).toBe(67000.0);
    expect(btc.indicators).not.toBeNull();
    expect(["strong_buy", "buy", "neutral", "caution", "sell"]).toContain(btc.signal);
    expect(Array.isArray(btc.signal_reasons)).toBe(true);
  });

  it("market returns dominance + advancing/declining", async () => {
    const r = await call(env, "GET", "/api/market");
    expect(r.status).toBe(200);
    expect(r.body.total_market_cap).toBeGreaterThan(0);
    expect(r.body.btc_dominance).toBeGreaterThan(0);
    expect(r.body.advancing + r.body.declining).toBeLessThanOrEqual(2);
  });

  it("feargreed returns value, history, interpretation, market_score", async () => {
    const r = await call(env, "GET", "/api/feargreed");
    expect(r.status).toBe(200);
    expect(r.body.value).toBe(72);
    expect(r.body.classification).toBe("Greed");
    expect(r.body.history).toHaveLength(7);
    expect(typeof r.body.interpretation).toBe("string");
    expect(r.body.market_score.score).toBeGreaterThanOrEqual(0);
    expect(r.body.market_score.reasons.length).toBeLessThanOrEqual(3);
  });

  it("history returns 14-day OHLC rows", async () => {
    const r = await call(env, "GET", "/api/history/bitcoin");
    expect(r.status).toBe(200);
    expect(r.body.coin_id).toBe("bitcoin");
    expect(r.body.days).toBe(14);
    expect(r.body.data[0]).toHaveProperty("close");
    expect(r.body.data[0]).toHaveProperty("date");
  });

  it("history 404s for an uncached coin", async () => {
    const r = await call(env, "GET", "/api/history/dogecoin");
    expect(r.status).toBe(404);
  });

  it("signals returns composite scores per coin", async () => {
    const r = await call(env, "GET", "/api/signals");
    expect(r.status).toBe(200);
    expect(r.body.signals).toHaveLength(2);
    const s = r.body.signals[0];
    expect(s).toHaveProperty("composite_score");
    expect(s).toHaveProperty("composite_verdict");
    expect(s).toHaveProperty("signal_score");
  });

  it("news returns the cached items", async () => {
    const r = await call(env, "GET", "/api/news");
    expect(r.status).toBe(200);
    expect(r.body.news).toHaveLength(2);
  });

  it("backtest returns aggregate stats", async () => {
    const r = await call(env, "GET", "/api/backtest/bitcoin");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("total_signals");
    expect(r.body).toHaveProperty("buy");
    expect(r.body).toHaveProperty("forward_days", 7);
  });
});

describe("watchlist", () => {
  it("add / list / remove is idempotent", async () => {
    expect((await call(env, "GET", "/api/watchlist", { token })).body).toEqual([]);
    await call(env, "POST", "/api/watchlist/bitcoin", { token });
    await call(env, "POST", "/api/watchlist/bitcoin", { token }); // idempotent
    const after = await call(env, "POST", "/api/watchlist/ethereum", { token });
    expect(after.body).toEqual(["bitcoin", "ethereum"]);
    const removed = await call(env, "DELETE", "/api/watchlist/bitcoin", { token });
    expect(removed.body).toEqual(["ethereum"]);
  });
});

describe("portfolios", () => {
  it("default portfolio always listed; create/delete named ones", async () => {
    expect((await call(env, "GET", "/api/portfolios", { token })).body).toEqual(["default"]);
    const created = await call(env, "POST", "/api/portfolios", { token, body: { name: "moon" } });
    expect(created.status).toBe(200);
    // Parity quirk (matches portfolio.list_portfolios): with named portfolios but
    // no materialised 'default' row, only the named ones are listed.
    expect((await call(env, "GET", "/api/portfolios", { token })).body).toEqual(["moon"]);
    // Once 'default' is materialised (e.g. via a deposit), it leads the list.
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 100 } });
    expect((await call(env, "GET", "/api/portfolios", { token })).body).toEqual(["default", "moon"]);
    const dup = await call(env, "POST", "/api/portfolios", { token, body: { name: "moon" } });
    expect(dup.status).toBe(409);
    const badName = await call(env, "POST", "/api/portfolios", { token, body: { name: "Bad Name!" } });
    expect(badName.status).toBe(409);
    const del = await call(env, "DELETE", "/api/portfolios/moon", { token });
    expect(del.status).toBe(200);
    const delDefault = await call(env, "DELETE", "/api/portfolios/default", { token });
    expect(delDefault.status).toBe(400);
    const delMissing = await call(env, "DELETE", "/api/portfolios/ghost", { token });
    expect(delMissing.status).toBe(404);
  });
});

describe("portfolio trading", () => {
  async function fund(amount = 10000) {
    return call(env, "POST", "/api/portfolio/deposit", { token, body: { amount } });
  }

  it("deposit increases cash and net_invested", async () => {
    const r = await fund(10000);
    expect(r.status).toBe(200);
    expect(r.body.cash).toBe(10000);
    expect(r.body.total_deposited).toBe(10000);
    expect(r.body.net_invested).toBe(10000);
  });

  it("buy then sell updates holdings and cash", async () => {
    await fund(10000);
    const buy = await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "bitcoin", usd_amount: 6700 } });
    expect(buy.status).toBe(200);
    const h = buy.body.holdings.find((x) => x.coin_id === "bitcoin");
    expect(h.amount).toBeCloseTo(0.1, 6);
    expect(buy.body.cash).toBeCloseTo(3300, 6);

    const sell = await call(env, "POST", "/api/portfolio/sell", { token, body: { coin_id: "bitcoin", usd_amount: 3350 } });
    expect(sell.status).toBe(200);
    expect(sell.body.cash).toBeCloseTo(6650, 6);
  });

  it("buy rejects when cash insufficient", async () => {
    const r = await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "bitcoin", usd_amount: 5000 } });
    expect(r.status).toBe(400);
  });

  it("buy rejects unknown coin (404) and sub-$1 (400)", async () => {
    await fund(10000);
    expect((await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "nope", usd_amount: 100 } })).status).toBe(404);
    expect((await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "bitcoin", usd_amount: 0.5 } })).status).toBe(400);
  });

  it("withdraw respects available cash", async () => {
    await fund(1000);
    expect((await call(env, "POST", "/api/portfolio/withdraw", { token, body: { amount: 2000 } })).status).toBe(400);
    const ok = await call(env, "POST", "/api/portfolio/withdraw", { token, body: { amount: 400 } });
    expect(ok.status).toBe(200);
    expect(ok.body.cash).toBe(600);
    expect(ok.body.total_withdrawn).toBe(400);
  });

  it("reset clears the portfolio", async () => {
    await fund(10000);
    await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "bitcoin", usd_amount: 1000 } });
    const r = await call(env, "POST", "/api/portfolio/reset", { token });
    expect(r.status).toBe(200);
    expect(r.body.cash).toBe(0);
    expect(r.body.holdings).toEqual([]);
  });

  it("history accrues a snapshot after a write", async () => {
    await fund(10000);
    const h = await call(env, "GET", "/api/portfolio/history", { token });
    expect(h.status).toBe(200);
    expect(h.body.length).toBeGreaterThanOrEqual(1);
    expect(h.body[0]).toHaveProperty("total_value");
  });

  it("export returns CSV by default and JSON on request", async () => {
    await fund(10000);
    const csv = await call(env, "GET", "/api/portfolio/export", { token });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const jsonExp = await call(env, "GET", "/api/portfolio/export?format=json", { token });
    expect(jsonExp.status).toBe(200);
    expect(jsonExp.body).toHaveProperty("total_value");
  });

  it("recommendation returns a summary + recommendations", async () => {
    await fund(10000);
    const r = await call(env, "GET", "/api/portfolio/recommendation", { token });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("summary");
    expect(Array.isArray(r.body.recommendations)).toBe(true);
  });
});
