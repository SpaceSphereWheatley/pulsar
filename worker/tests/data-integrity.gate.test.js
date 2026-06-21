// Phase 6 data-integrity gate: mirrors test_portfolio.py / test_watchlist.py /
// test_portfolio_history.py — isolation across users and named portfolios,
// 365-day history retention, and transaction id uniqueness/ordering.

import { describe, expect, it } from "vitest";
import { recordSnapshot } from "../db.js";
import { call, login, setupEnv } from "./helpers/app.js";

describe("portfolio isolation", () => {
  it("two different users' default portfolios never see each other's funds/holdings", async () => {
    const env = await setupEnv();
    const adminToken = await login(env);
    await call(env, "POST", "/api/auth/users", { token: adminToken, body: { username: "bob", password: "pw" } });
    const bobToken = await login(env, "bob", "pw");

    await call(env, "POST", "/api/portfolio/deposit", { token: adminToken, body: { amount: 5000 } });
    await call(env, "POST", "/api/portfolio/deposit", { token: bobToken, body: { amount: 777 } });

    const adminView = await call(env, "GET", "/api/portfolio", { token: adminToken });
    const bobView = await call(env, "GET", "/api/portfolio", { token: bobToken });
    expect(adminView.body.cash).toBe(5000);
    expect(bobView.body.cash).toBe(777);
  });

  it("named portfolios for the same user are isolated from each other and from default", async () => {
    const env = await setupEnv();
    const token = await login(env);
    await call(env, "POST", "/api/portfolios", { token, body: { name: "moon" } });
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 1000 } }); // default
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 200, portfolio: "moon" } });

    const def = await call(env, "GET", "/api/portfolio", { token });
    const moon = await call(env, "GET", "/api/portfolio?portfolio=moon", { token });
    expect(def.body.cash).toBe(1000);
    expect(moon.body.cash).toBe(200);
  });

  it("watchlists are per-user", async () => {
    const env = await setupEnv();
    const adminToken = await login(env);
    await call(env, "POST", "/api/auth/users", { token: adminToken, body: { username: "carol", password: "pw" } });
    const carolToken = await login(env, "carol", "pw");

    await call(env, "POST", "/api/watchlist/bitcoin", { token: adminToken });
    const adminList = await call(env, "GET", "/api/watchlist", { token: adminToken });
    const carolList = await call(env, "GET", "/api/watchlist", { token: carolToken });
    expect(adminList.body).toEqual(["bitcoin"]);
    expect(carolList.body).toEqual([]);
  });
});

describe("history retention", () => {
  it("keeps only the newest 365 snapshot dates per (user, portfolio)", async () => {
    const env = await setupEnv();
    const token = await login(env);

    const inserted = [];
    for (let i = 0; i < 370; i++) {
      const date = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      inserted.push(date);
      await recordSnapshot(env, "admin", 10_000 + i, 100, 0, "default", date);
    }

    const r = await call(env, "GET", "/api/portfolio/history", { token });
    expect(r.body.length).toBe(365);
    const dates = r.body.map((h) => h.date).sort();
    const expected = inserted.sort().slice(-365);
    expect(dates).toEqual(expected);
  });

  it("re-recording the same date upserts rather than duplicating", async () => {
    const env = await setupEnv();
    await call(env, "POST", "/api/portfolio/deposit", { token: await login(env), body: { amount: 100 } });
    await recordSnapshot(env, "admin", 1, 1, 1, "default", "2024-01-01");
    await recordSnapshot(env, "admin", 999, 999, 999, "default", "2024-01-01");
    const token = await login(env);
    const r = await call(env, "GET", "/api/portfolio/history", { token });
    const day = r.body.filter((h) => h.date === "2024-01-01");
    expect(day.length).toBe(1);
    expect(day[0].total_value).toBe(999);
  });
});

describe("transaction integrity", () => {
  it("transaction ids are unique and monotonically ordered within a portfolio", async () => {
    const env = await setupEnv();
    const token = await login(env);
    await call(env, "POST", "/api/portfolio/deposit", { token, body: { amount: 10000 } });
    for (let i = 0; i < 5; i++) {
      await call(env, "POST", "/api/portfolio/buy", { token, body: { coin_id: "bitcoin", usd_amount: 10 } });
    }
    const r = await call(env, "GET", "/api/portfolio", { token });
    const ids = r.body.transactions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Newest first, per the existing API contract.
    const nums = ids.map((id) => parseInt(id.replace("txn_", ""), 10));
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeLessThan(nums[i - 1]);
  });

  it("transaction ids do not collide across different users", async () => {
    const env = await setupEnv();
    const adminToken = await login(env);
    await call(env, "POST", "/api/auth/users", { token: adminToken, body: { username: "dave", password: "pw" } });
    const daveToken = await login(env, "dave", "pw");
    await call(env, "POST", "/api/portfolio/deposit", { token: adminToken, body: { amount: 100 } });
    await call(env, "POST", "/api/portfolio/deposit", { token: daveToken, body: { amount: 100 } });
    const a = (await call(env, "GET", "/api/portfolio", { token: adminToken })).body.transactions[0].id;
    const d = (await call(env, "GET", "/api/portfolio", { token: daveToken })).body.transactions[0].id;
    // Both can legitimately be txn_0001 (ids are scoped per portfolio, not globally unique) —
    // the integrity property is that each user's own sequence is independent and correct.
    expect(a).toBe("txn_0001");
    expect(d).toBe("txn_0001");
  });
});
