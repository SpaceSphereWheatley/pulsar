// Phase 6 lazy-refresh gate: there is no scheduled() handler and no Cron
// Triggers config anymore — every cache refreshes itself the next time a
// request actually needs the data (see ensureCoinsFresh/ensureOhlcFresh/
// maybeRefreshNok in worker/index.js). These tests drive that behavior
// through the same HTTP routes the frontend calls, with global fetch stubbed
// (no live network calls). Mirrors the mocking philosophy of
// server/tests/conftest.py.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCoinsCache,
  getFeargreed,
  getMlScores,
  getNokMeta,
  getOhlc,
  setCoinsCache,
  setFeargreed,
  setNokRate,
  setOhlc,
} from "../db.js";
import { call, login, MOCK_COINS, MOCK_OHLC, setupEnv } from "./helpers/app.js";

function fakeFetch(routes) {
  return vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.url;
    for (const [matcher, body] of routes) {
      const matches = matcher instanceof RegExp ? matcher.test(url) : url.includes(matcher);
      if (matches) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllGlobals();
});

// `call()` invokes worker.fetch(req, env) with no ExecutionContext, which
// makes the background() helper in index.js await refreshes inline instead of
// firing them via ctx.waitUntil — so these tests can assert on D1 state
// synchronously right after the request resolves.
describe("lazy on-demand refresh (no cron triggers)", () => {
  it("GET /api/coins refreshes an empty coin cache from CoinGecko", async () => {
    const env = await setupEnv({ seedCaches: false });
    global.fetch = fakeFetch([["/coins/markets", Object.values(MOCK_COINS)], [/\/ohlc\?/, MOCK_OHLC]]);

    const r = await call(env, "GET", "/api/coins");

    expect(r.status).toBe(200);
    const { cache } = await getCoinsCache(env);
    expect(Object.keys(cache).sort()).toEqual(["bitcoin", "ethereum"]);
    expect(cache.bitcoin.current_price).toBe(67000.0);
  });

  it("a stale coin cache is served as-is, then refreshed for the next request", async () => {
    const env = await setupEnv({ seedCaches: false });
    const staleTs = Date.now() / 1000 - 10 * 60; // 10 min old, past the 5 min budget
    await setCoinsCache(env, MOCK_COINS, staleTs);
    for (const coinId of Object.keys(MOCK_COINS)) await setOhlc(env, coinId, MOCK_OHLC, Date.now() / 1000);

    const updatedMarkets = Object.values(MOCK_COINS).map((c) => ({ ...c, current_price: c.current_price + 1000 }));
    global.fetch = fakeFetch([["/coins/markets", updatedMarkets]]);

    const r = await call(env, "GET", "/api/coins");
    expect(r.status).toBe(200);
    expect(r.body.coins.find((c) => c.id === "bitcoin").price).toBe(67000.0); // served stale, not blocked

    const { cache } = await getCoinsCache(env);
    expect(cache.bitcoin.current_price).toBe(68000.0); // refreshed underneath by the time the request finished
  });

  it("missing OHLC for a coin is refreshed on the history route and retrains ML", async () => {
    const env = await setupEnv({ seedCaches: false });
    await setCoinsCache(env, MOCK_COINS, Date.now() / 1000);
    global.fetch = fakeFetch([[/\/ohlc\?/, MOCK_OHLC]]);

    const r = await call(env, "GET", "/api/history/bitcoin");

    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    const btcOhlc = await getOhlc(env, "bitcoin");
    expect(btcOhlc.length).toBe(MOCK_OHLC.length);
    const { scores, quality } = await getMlScores(env);
    expect(typeof scores.bitcoin).toBe("number");
    expect(typeof quality.bitcoin).toBe("number");
  });

  it("GET /api/feargreed refreshes Fear & Greed and the USD->NOK rate when cold", async () => {
    const env = await setupEnv({ seedCaches: false });
    global.fetch = fakeFetch([
      ["alternative.me", { data: [{ value: "55", value_classification: "Fear", timestamp: "1715000000" }] }],
      ["frankfurter.app", { amount: 1, base: "USD", date: "2024-01-01", rates: { NOK: 10.7 } }],
    ]);

    const r = await call(env, "GET", "/api/feargreed");

    expect(r.status).toBe(200);
    expect(r.body.value).toBe(55);
    const fg = await getFeargreed(env);
    expect(fg.ts).toBeGreaterThan(0);
    const nok = await getNokMeta(env);
    expect(nok.rate).toBeCloseTo(10.7, 6);
  });

  it("a stale Fear & Greed / NOK cache is refreshed in the background", async () => {
    const env = await setupEnv({ seedCaches: false });
    const staleTs = Date.now() / 1000 - 2 * 60 * 60; // 2h old, past the 1h budget
    await setFeargreed(env, { data: [{ value: "40", value_classification: "Fear", timestamp: "1715000000" }] }, staleTs);
    await setNokRate(env, 10.5, staleTs);
    global.fetch = fakeFetch([
      ["alternative.me", { data: [{ value: "61", value_classification: "Greed", timestamp: "1715100000" }] }],
      ["frankfurter.app", { amount: 1, base: "USD", date: "2024-01-01", rates: { NOK: 11.1 } }],
    ]);

    await call(env, "GET", "/api/feargreed");

    const fg = await getFeargreed(env);
    expect(fg.data.data[0].value).toBe("61");
    const nok = await getNokMeta(env);
    expect(nok.rate).toBeCloseTo(11.1, 6);
  });

  it("GET /api/news refreshes news, capped at 20 items, when cold", async () => {
    const env = await setupEnv({ seedCaches: false });
    const items = Array.from({ length: 25 }, (_, i) => ({ title: `Story ${i}`, url: `https://x/${i}`, description: "d" }));
    global.fetch = fakeFetch([["news", { data: items }]]);

    const r = await call(env, "GET", "/api/news");

    expect(r.status).toBe(200);
    expect(r.body.news.length).toBe(20);
    expect(r.body.news[0].title).toBe("Story 0");
  });

  it("GET /api/portfolio upserts today's history snapshot on view, without needing a daily cron", async () => {
    const env = await setupEnv();
    const token = await login(env);
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 500 } });

    const hist = await call(env, "GET", "/api/portfolio/history", { token });
    const before = hist.body.length;

    await call(env, "GET", "/api/portfolio", { token }); // plain view, no mutation

    const histAfter = await call(env, "GET", "/api/portfolio/history", { token });
    expect(histAfter.body.length).toBe(before); // same day, upserted not duplicated
    expect(histAfter.body.at(-1).total_value).toBe(500);
  });
});
