// Phase 6 cold-start gate: a fresh Worker invocation against an empty D1 (no
// caches ever seeded) must not crash. Routes fall back to a 503/empty-shape
// response instead of assuming a warm in-memory cache (the Worker has no
// in-memory cache at all — every read goes through D1 — so this also proves
// the read path itself tolerates empty tables).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, login, setupEnv } from "./helpers/app.js";

beforeEach(() => {
  // Cold D1 also means no network is reachable for on-demand refresh fallbacks;
  // stub fetch to always fail, the same as a sandboxed/offline cold start.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unavailable"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cold start (empty D1, no caches)", () => {
  it("health reports degraded instead of crashing", async () => {
    const env = await setupEnv({ seedCaches: false });
    const r = await call(env, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("degraded");
    expect(r.body.caches.coins.count).toBe(0);
  });

  it("coins/market/signals 503 cleanly when the coin cache is empty", async () => {
    const env = await setupEnv({ seedCaches: false });
    expect((await call(env, "GET", "/api/coins")).status).toBe(503);
    expect((await call(env, "GET", "/api/market")).status).toBe(503);
    expect((await call(env, "GET", "/api/signals")).status).toBe(503);
  });

  it("feargreed 503s cleanly when cold and the refresh fallback can't reach the network", async () => {
    const env = await setupEnv({ seedCaches: false });
    const r = await call(env, "GET", "/api/feargreed");
    expect(r.status).toBe(503);
  });

  it("news degrades to an empty list rather than erroring when cold and offline", async () => {
    const env = await setupEnv({ seedCaches: false });
    const r = await call(env, "GET", "/api/news");
    expect(r.status).toBe(200);
    expect(r.body.news).toEqual([]);
  });

  it("history/backtest 404 for an uncached coin instead of crashing", async () => {
    const env = await setupEnv({ seedCaches: false });
    expect((await call(env, "GET", "/api/history/bitcoin")).status).toBe(404);
    expect((await call(env, "GET", "/api/backtest/bitcoin")).status).toBe(404);
  });

  it("auth and portfolio routes work normally even with cold market caches", async () => {
    const env = await setupEnv({ seedCaches: false });
    const token = await login(env);
    const deposit = await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 100 } });
    expect(deposit.status).toBe(200);
    expect(deposit.body.cash).toBe(100);
  });

  it("buying against a coin with no cached price fails gracefully (404), not a crash", async () => {
    const env = await setupEnv({ seedCaches: false });
    const token = await login(env);
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 1000 } });
    const r = await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "bitcoin", usd_amount: 100 } });
    expect(r.status).toBe(404);
  });
});
