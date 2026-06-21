// Test harness: builds an env with a fresh D1, seeds the market caches with the
// same MOCK_* data conftest.py uses, and exposes a fetch driver + login helper.

import worker, { runScheduled } from "../../index.js";
import { _resetSeedGuard, setCoinsCache, setFeargreed, setNews, setOhlc } from "../../db.js";
import { makeEnv } from "./d1.js";

export const MOCK_COINS = {
  bitcoin: {
    id: "bitcoin",
    symbol: "btc",
    name: "Bitcoin",
    image: "https://example.com/btc.png",
    current_price: 67000.0,
    market_cap: 1320000000000,
    market_cap_rank: 1,
    total_volume: 34200000000,
    price_change_percentage_24h: 2.41,
    price_change_percentage_7d_in_currency: -1.12,
  },
  ethereum: {
    id: "ethereum",
    symbol: "eth",
    name: "Ethereum",
    image: "https://example.com/eth.png",
    current_price: 3500.0,
    market_cap: 420000000000,
    market_cap_rank: 2,
    total_volume: 15000000000,
    price_change_percentage_24h: 1.5,
    price_change_percentage_7d_in_currency: 2.3,
  },
};

// 90 cyclic candles — identical formula to conftest.MOCK_OHLC.
export const MOCK_OHLC = Array.from({ length: 90 }, (_, i) => [
  1_715_000_000_000 - i * 86_400_000,
  65000.0 + (i % 5) * 200,
  67000.0 + (i % 5) * 200 + 500,
  63000.0 + (i % 5) * 200 - 500,
  65000.0 + ((i % 7) - 3) * 300,
]);

export const MOCK_FEARGREED = {
  data: [
    { value: "72", value_classification: "Greed", timestamp: "1715000000" },
    { value: "68", value_classification: "Greed", timestamp: "1714913600" },
    { value: "65", value_classification: "Greed", timestamp: "1714827200" },
    { value: "60", value_classification: "Greed", timestamp: "1714740800" },
    { value: "58", value_classification: "Fear", timestamp: "1714654400" },
    { value: "55", value_classification: "Fear", timestamp: "1714568000" },
    { value: "55", value_classification: "Fear", timestamp: "1714481600" },
  ],
};

export const MOCK_NEWS = [
  { title: "Bitcoin reaches new milestone", url: "https://example.com/btc-news", description: "BTC surges." },
  { title: "Ethereum upgrade scheduled", url: "https://example.com/eth-news", description: "Next fork dated." },
];

// Build an env and (by default) pre-seed the market caches.
export async function setupEnv({ seedCaches = true, overrides = {} } = {}) {
  _resetSeedGuard();
  const env = makeEnv(overrides);
  if (seedCaches) {
    const now = Date.now() / 1000;
    await setCoinsCache(env, MOCK_COINS, now);
    for (const coinId of Object.keys(MOCK_COINS)) await setOhlc(env, coinId, MOCK_OHLC, now);
    await setFeargreed(env, MOCK_FEARGREED, now);
    await setNews(env, MOCK_NEWS, now);
  }
  return env;
}

// Issue a request against the Worker. Returns { status, body, headers, res }.
export async function call(env, method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const req = new Request(`https://pulsar.test${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers, res };
}

// Log in and return the bearer token.
export async function login(env, username = "admin", password = "admin") {
  const r = await call(env, "POST", "/api/auth/login", { body: { username, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

export { runScheduled };
