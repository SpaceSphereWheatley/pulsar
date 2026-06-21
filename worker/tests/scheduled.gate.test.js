// Phase 6 scheduled-job gate: each cron-mapped job, run directly against a
// seeded D1 with global fetch stubbed (no live network calls), must produce
// the expected cache-table updates. Mirrors the mocking philosophy of
// server/tests/conftest.py, applied to the Worker's cron dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCoinsCache,
  getFeargreed,
  getMlScores,
  getNews,
  getNokRate,
  getOhlc,
} from "../db.js";
import { call, login, MOCK_COINS, MOCK_OHLC, runScheduled, setupEnv } from "./helpers/app.js";

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

describe("scheduled jobs (cron dispatch)", () => {
  it("*/5 * * * * refreshes the coins cache from CoinGecko markets", async () => {
    const env = await setupEnv({ seedCaches: false });
    const markets = Object.values(MOCK_COINS);
    global.fetch = fakeFetch([["/coins/markets", markets]]);

    await runScheduled({ cron: "*/5 * * * *" }, env);

    const { cache } = await getCoinsCache(env);
    expect(Object.keys(cache).sort()).toEqual(["bitcoin", "ethereum"]);
    expect(cache.bitcoin.current_price).toBe(67000.0);
  });

  it("0 */6 * * * refreshes OHLC for every cached coin, then retrains ML", async () => {
    const env = await setupEnv({ seedCaches: false });
    await call(env, "GET", "/api/health"); // no-op, just exercises ensureSeeded path
    global.fetch = fakeFetch([["/coins/markets", Object.values(MOCK_COINS)], [/\/ohlc\?/, MOCK_OHLC]]);
    await runScheduled({ cron: "*/5 * * * *" }, env); // seed coins cache first

    global.fetch = fakeFetch([[/\/ohlc\?/, MOCK_OHLC]]);
    await runScheduled({ cron: "0 */6 * * *" }, env);

    const btcOhlc = await getOhlc(env, "bitcoin");
    expect(btcOhlc).not.toBeNull();
    expect(btcOhlc.length).toBe(MOCK_OHLC.length);

    const { scores, quality } = await getMlScores(env);
    expect(scores.bitcoin).toBeDefined();
    expect(typeof scores.bitcoin).toBe("number");
    expect(typeof quality.bitcoin).toBe("number");
  });

  it("0 * * * * refreshes Fear & Greed and the USD->NOK rate", async () => {
    const env = await setupEnv({ seedCaches: false });
    global.fetch = fakeFetch([
      ["alternative.me", { data: [{ value: "55", value_classification: "Fear", timestamp: "1715000000" }] }],
      ["frankfurter.app", { amount: 1, base: "USD", date: "2024-01-01", rates: { NOK: 10.7 } }],
    ]);

    await runScheduled({ cron: "0 * * * *" }, env);

    const fg = await getFeargreed(env);
    expect(fg.data.data[0].value).toBe("55");
    expect(fg.ts).toBeGreaterThan(0);
    const nok = await getNokRate(env);
    expect(nok).toBeCloseTo(10.7, 6);
  });

  it("*/30 * * * * refreshes news, capped at 20 items", async () => {
    const env = await setupEnv({ seedCaches: false });
    const items = Array.from({ length: 25 }, (_, i) => ({ title: `Story ${i}`, url: `https://x/${i}`, description: "d" }));
    global.fetch = fakeFetch([["news", { data: items }]]);

    await runScheduled({ cron: "*/30 * * * *" }, env);

    const { news } = await getNews(env);
    expect(news.length).toBe(20);
    expect(news[0].title).toBe("Story 0");
  });

  it("0 0 * * * snapshots every user's every portfolio without crashing on an empty user set", async () => {
    const env = await setupEnv();
    await runScheduled({ cron: "0 0 * * *" }, env); // no users yet beyond admin, admin has no portfolio
    await login(env);
    const token = await login(env);
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 500 } });
    await runScheduled({ cron: "0 0 * * *" }, env);
    const hist = await call(env, "GET", "/api/portfolio/history", { token });
    expect(hist.body.length).toBeGreaterThanOrEqual(1);
  });

  it("an unrecognized cron expression is a no-op, not an error", async () => {
    const env = await setupEnv();
    await expect(runScheduled({ cron: "*/1 * * * *" }, env)).resolves.toBeUndefined();
  });
});
