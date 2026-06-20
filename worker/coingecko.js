// Outbound market-data fetching — replaces data.py. Uses the Worker's global
// fetch(); each refresh writes the result into the D1 cache tables. Bounded retry
// with exponential backoff mirrors data._with_retry.

import { scoreCoin } from "./ml.js";
import {
  getCoinsCache,
  getOhlc,
  setCoinsCache,
  setFeargreed,
  setMlScores,
  setNews,
  setNokRate,
  setOhlc,
} from "./db.js";

const RETRY_ATTEMPTS = 3;
const TOP_N = 10;

async function withRetry(fn) {
  let delay = 500;
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }
  throw lastErr;
}

function cgBase(env) {
  return env.COINGECKO_PRO_API_KEY ? "https://pro-api.coingecko.com" : "https://api.coingecko.com";
}
function cgHeaders(env) {
  if (env.COINGECKO_PRO_API_KEY) return { "x-cg-pro-api-key": env.COINGECKO_PRO_API_KEY };
  if (env.COINGECKO_API_KEY) return { "x-cg-demo-api-key": env.COINGECKO_API_KEY };
  return {};
}

async function getJson(url, headers = {}) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

export async function refreshCoins(env) {
  const url =
    `${cgBase(env)}/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc` +
    `&per_page=${TOP_N}&page=1&sparkline=false&price_change_percentage=24h,7d`;
  const raw = await withRetry(() => getJson(url, cgHeaders(env)));
  const byId = {};
  for (const coin of raw) byId[coin.id] = coin;
  await setCoinsCache(env, byId, Date.now() / 1000);
  return byId;
}

export async function refreshOhlc(env, coinId) {
  const url = `${cgBase(env)}/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=14`;
  const raw = await withRetry(() => getJson(url, cgHeaders(env)));
  await setOhlc(env, coinId, raw, Date.now() / 1000);
  return raw;
}

export async function refreshAllOhlc(env) {
  const { cache } = await getCoinsCache(env);
  for (const coinId of Object.keys(cache)) {
    try {
      await refreshOhlc(env, coinId);
    } catch {
      // one bad coin shouldn't abort the rest
    }
  }
}

export async function refreshFeargreed(env) {
  const data = await withRetry(() => getJson("https://api.alternative.me/fng/?limit=7"));
  await setFeargreed(env, data, Date.now() / 1000);
  return data;
}

export async function refreshNews(env) {
  const payload = await withRetry(() => getJson("https://api.coingecko.com/api/v3/news"));
  const news = (payload.data || []).slice(0, 20);
  await setNews(env, news, Date.now() / 1000);
  return news;
}

export async function refreshNokRate(env) {
  const payload = await withRetry(() => getJson("https://api.frankfurter.app/latest?from=USD&to=NOK"));
  const rate = parseFloat(payload.rates.NOK);
  await setNokRate(env, rate, Date.now() / 1000);
  return rate;
}

// Train ML per coin over the cached OHLC and persist scores (was _refresh_ml).
export async function refreshMl(env) {
  const { cache } = await getCoinsCache(env);
  const byCoin = {};
  for (const coinId of Object.keys(cache)) {
    const ohlc = await getOhlc(env, coinId);
    if (!ohlc) continue;
    const { score, quality } = scoreCoin(ohlc);
    if (score !== null) byCoin[coinId] = { score, quality };
  }
  await setMlScores(env, byCoin, Date.now() / 1000);
  return byCoin;
}
