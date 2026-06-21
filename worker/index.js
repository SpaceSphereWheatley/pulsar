// PULSAR Cloudflare Worker — the entire backend. Owns all /api/* routes, auth,
// and scheduled cache refresh; proxies everything else to the Pages project
// (the static frontend). Single-file router in the panhandle style.

import { createToken, decodeToken } from "./auth.js";
import { runBacktest } from "./backtest.js";
import {
  ValueErr,
  NotFoundErr,
  addCoin,
  authenticate,
  changePassword,
  createPortfolio,
  createUser,
  deletePortfolio,
  deleteUser,
  ensureSeeded,
  getCoinsCache,
  getFeargreed,
  getNews,
  getOhlc,
  listPortfolios,
  listUsers,
  loadHistory,
  loadPortfolioObj,
  loadWatchlist,
  recordSnapshot,
  removeCoin,
  resetPortfolio,
  savePortfolioObj,
} from "./db.js";
import {
  buildCoin,
  buildSignals,
  fgInterpretation,
  marketScore,
  portfolioResponse,
} from "./market.js";
import { recommend } from "./recommendation.js";
import {
  refreshAllOhlc,
  refreshCoins,
  refreshFeargreed,
  refreshMl,
  refreshNews,
  refreshNokRate,
} from "./coingecko.js";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function secret(env) {
  return env.PULSAR_SECRET_KEY || "pulsar-dev-secret-change-before-deploying";
}
function expireMinutes(env) {
  return parseInt(env.PULSAR_TOKEN_EXPIRE_MINUTES || "60", 10);
}

async function currentUser(req, env) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer (.+)$/i);
  if (!m) throw new HttpError(401, "Invalid or expired token");
  const payload = await decodeToken(m[1], secret(env));
  if (!payload) throw new HttpError(401, "Invalid or expired token");
  return { username: payload.sub, is_admin: payload.admin || false };
}

async function requireAdmin(req, env) {
  const user = await currentUser(req, env);
  if (!user.is_admin) throw new HttpError(403, "Admin access required");
  return user;
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(422, "Invalid JSON body");
  }
}

// Validate required body fields (FastAPI/pydantic would return 422).
function need(body, fields) {
  for (const [k, type] of Object.entries(fields)) {
    const v = body?.[k];
    if (v === undefined || v === null) throw new HttpError(422, `Missing field: ${k}`);
    if (type === "number" && typeof v !== "number") throw new HttpError(422, `Field ${k} must be a number`);
    if (type === "string" && typeof v !== "string") throw new HttpError(422, `Field ${k} must be a string`);
  }
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

// ── Write helper: response + daily snapshot (was _write_response) ─────────────

async function writeResponse(env, username, pfName) {
  const resp = await portfolioResponse(env, username, pfName);
  await recordSnapshot(env, username, resp.total_value, resp.cash, resp.total_pnl_pct, pfName);
  return resp;
}

async function getCoinPrice(env, coinId) {
  const { cache } = await getCoinsCache(env);
  const coin = cache[coinId];
  return coin ? coin.current_price : null;
}

// ── Router ────────────────────────────────────────────────────────────────────

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const qp = (k, d) => url.searchParams.get(k) ?? d;

  await ensureSeeded(env);

  // ---- Auth ----
  if (path === "/api/auth/login" && method === "POST") {
    const body = await readBody(req);
    need(body, { username: "string", password: "string" });
    const user = await authenticate(env, body.username, body.password);
    if (!user) throw new HttpError(401, "Invalid credentials");
    const token = await createToken(user.username, user.is_admin, secret(env), expireMinutes(env));
    return json({ access_token: token, token_type: "bearer", username: user.username, is_admin: user.is_admin });
  }

  if (path === "/api/auth/password" && method === "POST") {
    const user = await currentUser(req, env);
    const body = await readBody(req);
    need(body, { current_password: "string", new_password: "string" });
    if (!body.new_password) throw new HttpError(400, "New password cannot be empty");
    if (!(await changePassword(env, user.username, body.current_password, body.new_password))) {
      throw new HttpError(401, "Current password is incorrect");
    }
    return json({ changed: true });
  }

  if (path === "/api/auth/users" && method === "GET") {
    await requireAdmin(req, env);
    return json(await listUsers(env));
  }

  if (path === "/api/auth/users" && method === "POST") {
    const admin = await requireAdmin(req, env);
    const body = await readBody(req);
    need(body, { username: "string", password: "string" });
    const username = body.username.trim();
    if (!username || !body.password) throw new HttpError(400, "username and password are required");
    try {
      return json(await createUser(env, username, body.password, admin.username));
    } catch (e) {
      if (e instanceof ValueErr) throw new HttpError(409, e.message);
      throw e;
    }
  }

  let m;
  if ((m = path.match(/^\/api\/auth\/users\/(.+)$/)) && method === "DELETE") {
    await requireAdmin(req, env);
    const username = decodeURIComponent(m[1]);
    if (!(await deleteUser(env, username))) {
      throw new HttpError(404, `User '${username}' not found or cannot be deleted`);
    }
    return json({ deleted: username });
  }

  // ---- Public market data ----
  if (path === "/api/health" && method === "GET") {
    const { cache } = await getCoinsCache(env);
    const count = Object.keys(cache).length;
    return json({ status: count ? "ok" : "degraded", caches: { coins: { count } } });
  }

  if (path === "/api/coins" && method === "GET") {
    const { cache, ts } = await getCoinsCache(env);
    if (!Object.keys(cache).length) throw new HttpError(503, "Coin data not yet available");
    const coins = [];
    for (const raw of Object.values(cache)) coins.push(await buildCoin(env, raw));
    return json({ updated_at: new Date(ts * 1000).toISOString(), coins });
  }

  if (path === "/api/market" && method === "GET") {
    const { cache } = await getCoinsCache(env);
    if (!Object.keys(cache).length) throw new HttpError(503, "Coin data not yet available");
    const coins = Object.values(cache);
    const totalMc = coins.reduce((a, c) => a + (c.market_cap || 0), 0);
    const totalVol = coins.reduce((a, c) => a + (c.total_volume || 0), 0);
    const btc = cache.bitcoin || {};
    const eth = cache.ethereum || {};
    const { pyround } = await import("./series.js");
    const changes = coins.map((c) => c.price_change_percentage_24h || 0.0);
    return json({
      total_market_cap: totalMc,
      total_volume_24h: totalVol,
      btc_dominance: totalMc ? pyround(((btc.market_cap || 0) / totalMc) * 100, 1) : 0,
      eth_dominance: totalMc ? pyround(((eth.market_cap || 0) / totalMc) * 100, 1) : 0,
      avg_change_24h: changes.length ? pyround(changes.reduce((a, b) => a + b, 0) / changes.length, 2) : 0.0,
      advancing: changes.filter((ch) => ch > 0).length,
      declining: changes.filter((ch) => ch < 0).length,
    });
  }

  if (path === "/api/feargreed" && method === "GET") {
    let { data } = await getFeargreed(env);
    if (!data) {
      try {
        data = await refreshFeargreed(env);
      } catch {
        /* fall through to 503 */
      }
    }
    if (!data) throw new HttpError(503, "Fear & Greed data not available");
    const pts = data.data || [];
    if (!pts.length) throw new HttpError(503, "Fear & Greed data empty");
    const value = parseInt(pts[0].value, 10);
    const yesterday = pts.length > 1 ? parseInt(pts[1].value, 10) : value;
    const lastWeek = pts.length > 6 ? parseInt(pts[6].value, 10) : value;
    const history = pts.map((dp) => ({
      date: dp.timestamp ?? "",
      value: parseInt(dp.value, 10),
      classification: dp.value_classification,
    }));
    const { cache: coinsCache } = await getCoinsCache(env);
    return json({
      value,
      classification: pts[0].value_classification,
      yesterday,
      last_week: lastWeek,
      trend: value - yesterday,
      history,
      interpretation: fgInterpretation(value, value - lastWeek),
      market_score: marketScore(value, coinsCache),
    });
  }

  if ((m = path.match(/^\/api\/history\/(.+)$/)) && method === "GET") {
    const coinId = decodeURIComponent(m[1]);
    const ohlc = await getOhlc(env, coinId);
    if (ohlc === null) throw new HttpError(404, `No history for ${coinId}`);
    const data = ohlc.map((c) => ({
      date: new Date(c[0]).toISOString().slice(0, 10),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
    }));
    return json({ coin_id: coinId, days: 14, data });
  }

  if (path === "/api/signals" && method === "GET") {
    const { cache } = await getCoinsCache(env);
    if (!Object.keys(cache).length) throw new HttpError(503, "Coin data not yet available");
    const { detailed, ts } = await buildSignals(env, true);
    return json({ updated_at: new Date(ts * 1000).toISOString(), signals: detailed });
  }

  if (path === "/api/news" && method === "GET") {
    let { news, ts } = await getNews(env);
    if (!news || !news.length) {
      try {
        news = await refreshNews(env);
        ts = Date.now() / 1000;
      } catch {
        news = news || [];
      }
    }
    return json({ news, updated_at: ts ? new Date(ts * 1000).toISOString() : null });
  }

  if ((m = path.match(/^\/api\/backtest\/(.+)$/)) && method === "GET") {
    const coinId = decodeURIComponent(m[1]);
    const ohlc = await getOhlc(env, coinId);
    if (ohlc === null) throw new HttpError(404, `No OHLC data for ${coinId}`);
    return json(runBacktest(ohlc));
  }

  // ---- Watchlist ----
  if (path === "/api/watchlist" && method === "GET") {
    const user = await currentUser(req, env);
    return json(await loadWatchlist(env, user.username));
  }
  if ((m = path.match(/^\/api\/watchlist\/(.+)$/)) && method === "POST") {
    const user = await currentUser(req, env);
    return json(await addCoin(env, user.username, decodeURIComponent(m[1])));
  }
  if ((m = path.match(/^\/api\/watchlist\/(.+)$/)) && method === "DELETE") {
    const user = await currentUser(req, env);
    return json(await removeCoin(env, user.username, decodeURIComponent(m[1])));
  }

  // ---- Portfolio management ----
  if (path === "/api/portfolios" && method === "GET") {
    const user = await currentUser(req, env);
    return json(await listPortfolios(env, user.username));
  }
  if (path === "/api/portfolios" && method === "POST") {
    const user = await currentUser(req, env);
    const body = await readBody(req);
    need(body, { name: "string" });
    const name = body.name.trim();
    if (!name) throw new HttpError(400, "Portfolio name is required");
    try {
      await createPortfolio(env, user.username, name);
      return json({ created: name });
    } catch (e) {
      if (e instanceof ValueErr) throw new HttpError(409, e.message);
      throw e;
    }
  }
  if ((m = path.match(/^\/api\/portfolios\/(.+)$/)) && method === "DELETE") {
    const user = await currentUser(req, env);
    const name = decodeURIComponent(m[1]);
    try {
      await deletePortfolio(env, user.username, name);
      return json({ deleted: name });
    } catch (e) {
      if (e instanceof ValueErr) throw new HttpError(400, e.message);
      if (e instanceof NotFoundErr) throw new HttpError(404, e.message);
      throw e;
    }
  }

  // ---- Portfolio operations ----
  if (path === "/api/portfolio" && method === "GET") {
    const user = await currentUser(req, env);
    return json(await portfolioResponse(env, user.username, qp("portfolio", "default")));
  }
  if (path === "/api/portfolio/history" && method === "GET") {
    const user = await currentUser(req, env);
    return json(await loadHistory(env, user.username, qp("portfolio", "default")));
  }
  if (path === "/api/portfolio/export" && method === "GET") {
    const user = await currentUser(req, env);
    const pfName = qp("portfolio", "default");
    const format = qp("format", "csv");
    const resp = await portfolioResponse(env, user.username, pfName);
    if (format === "json") return json(resp);
    return new Response(portfolioCsv(resp, pfName), {
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="portfolio_${user.username}_${pfName}.csv"`,
      },
    });
  }
  if (path === "/api/portfolio/buy" && method === "POST") {
    return json(await handleTrade(req, env, "buy"));
  }
  if (path === "/api/portfolio/sell" && method === "POST") {
    return json(await handleTrade(req, env, "sell"));
  }
  if (path === "/api/portfolio/reset" && method === "POST") {
    const user = await currentUser(req, env);
    const pfName = qp("portfolio", "default");
    await resetPortfolio(env, user.username, pfName);
    return json(await writeResponse(env, user.username, pfName));
  }
  if (path === "/api/portfolio/deposit" && method === "POST") {
    return json(await handleFunds(req, env, "deposit"));
  }
  if (path === "/api/portfolio/withdraw" && method === "POST") {
    return json(await handleFunds(req, env, "withdraw"));
  }
  if (path === "/api/portfolio/recommendation" && method === "GET") {
    const user = await currentUser(req, env);
    const pfName = qp("portfolio", "default");
    const pf = await loadPortfolioObj(env, user.username, pfName);
    const { cache: coinsCache } = await getCoinsCache(env);
    const { compact: signals } = await buildSignals(env, false);
    let totalHeld = 0.0;
    for (const [cid, h] of Object.entries(pf.holdings)) {
      totalHeld += h.amount * (coinsCache[cid]?.current_price || h.avg_buy_price);
    }
    const totalValue = pf.cash + totalHeld;
    return json(recommend(pf, coinsCache, signals, totalValue));
  }

  // Unknown /api route
  if (path.startsWith("/api/")) throw new HttpError(404, "Not found");

  // Non-API → proxy to the Pages project (static frontend).
  return proxyToPages(req, env);
}

// ---- Trade / funds handlers (ported from main.py mutation logic) ----

async function handleTrade(req, env, kind) {
  const user = await currentUser(req, env);
  const body = await readBody(req);
  need(body, { coin_id: "string", usd_amount: "number" });
  const coinId = body.coin_id;
  const usdAmount = body.usd_amount;
  const pfName = body.portfolio || "default";
  if (usdAmount < 1) throw new HttpError(400, "Minimum trade is $1");
  const price = await getCoinPrice(env, coinId);
  if (price === null) throw new HttpError(404, `Unknown coin: ${coinId}`);
  const pf = await loadPortfolioObj(env, user.username, pfName);

  if (kind === "buy") {
    if (usdAmount > pf.cash) throw new HttpError(400, "Insufficient cash");
    const amount = usdAmount / price;
    const h = pf.holdings[coinId];
    if (h) {
      const newTotal = h.amount + amount;
      h.avg_buy_price = (h.amount * h.avg_buy_price + amount * price) / newTotal;
      h.amount = newTotal;
    } else {
      pf.holdings[coinId] = { amount, avg_buy_price: price };
    }
    pf.cash -= usdAmount;
    pf.transactions.push(txn(pf, "buy", { coin_id: coinId, amount, price, total: usdAmount }));
  } else {
    const h = pf.holdings[coinId];
    if (!h) throw new HttpError(400, `No holding for ${coinId}`);
    if (usdAmount > h.amount * price) throw new HttpError(400, "Cannot sell more than current holding value");
    const sellAmount = usdAmount / price;
    h.amount -= sellAmount;
    if (h.amount < 1e-10) delete pf.holdings[coinId];
    pf.cash += usdAmount;
    pf.transactions.push(txn(pf, "sell", { coin_id: coinId, amount: sellAmount, price, total: usdAmount }));
  }
  await savePortfolioObj(env, user.username, pfName, pf);
  return writeResponse(env, user.username, pfName);
}

async function handleFunds(req, env, kind) {
  const user = await currentUser(req, env);
  const body = await readBody(req);
  need(body, { amount: "number" });
  const amount = body.amount;
  const pfName = body.portfolio || "default";
  if (amount <= 0) throw new HttpError(400, "Amount must be positive");
  const pf = await loadPortfolioObj(env, user.username, pfName);
  if (kind === "deposit") {
    pf.cash += amount;
    pf.total_deposited = (pf.total_deposited ?? pf.initial_cash ?? 0.0) + amount;
    pf.transactions.push(txn(pf, "deposit", { total: amount }));
  } else {
    if (amount > pf.cash) throw new HttpError(400, "Insufficient cash to withdraw");
    pf.cash -= amount;
    pf.total_withdrawn = (pf.total_withdrawn ?? 0.0) + amount;
    pf.transactions.push(txn(pf, "withdrawal", { total: amount }));
  }
  await savePortfolioObj(env, user.username, pfName, pf);
  return writeResponse(env, user.username, pfName);
}

// txn_NNNN id matching main.py: f"txn_{len(transactions)+1:04d}".
function txn(pf, type, fields) {
  const seq = pf.transactions.length + 1;
  const id = `txn_${String(seq).padStart(4, "0")}`;
  return { id, type, ...fields, timestamp: nowIso() };
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\r\n";
}
function portfolioCsv(resp, pfName) {
  let out = "";
  out += csvRow(["section", "portfolio", pfName]);
  out += csvRow([]);
  out += csvRow(["holding", "coin_id", "symbol", "amount", "avg_buy_price", "value", "pnl"]);
  for (const h of resp.holdings) {
    out += csvRow(["holding", h.coin_id, h.symbol, h.amount, h.avg_buy_price, h.value, h.pnl]);
  }
  out += csvRow([]);
  out += csvRow(["transaction", "id", "type", "coin_id", "amount", "price", "total", "timestamp"]);
  for (const t of resp.transactions) {
    out += csvRow(["transaction", t.id, t.type, t.coin_id, t.amount, t.price, t.total, t.timestamp]);
  }
  return out;
}

async function proxyToPages(req, env) {
  if (!env.PAGES_HOST) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  url.hostname = env.PAGES_HOST;
  url.protocol = "https:";
  url.port = "";
  return fetch(new Request(url, req));
}

// ── Scheduled (cron) — replaces APScheduler jobs ──────────────────────────────
// wrangler.toml maps several cron expressions; dispatch by event.cron.

async function runScheduled(event, env) {
  const cron = event.cron;
  if (cron === "*/5 * * * *") {
    await refreshCoins(env); // coins (was 60s; Cron min is 1m, use 5m)
  } else if (cron === "0 */6 * * *") {
    await refreshAllOhlc(env); // OHLC every 6h
    await refreshMl(env); // ML retrain after fresh OHLC
  } else if (cron === "0 * * * *") {
    await refreshFeargreed(env); // hourly
    await refreshNokRate(env); // hourly
  } else if (cron === "*/30 * * * *") {
    await refreshNews(env); // every 30m
  } else if (cron === "0 0 * * *") {
    await snapshotAllPortfolios(env); // daily
  }
}

async function snapshotAllPortfolios(env) {
  for (const u of await listUsers(env)) {
    for (const pfName of await listPortfolios(env, u.username)) {
      try {
        const resp = await portfolioResponse(env, u.username, pfName);
        await recordSnapshot(env, u.username, resp.total_value, resp.cash, resp.total_pnl_pct, pfName);
      } catch {
        /* one bad portfolio shouldn't stop the job */
      }
    }
  }
}

// ── Entry points ──────────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) {
        return json({ detail: e.detail }, e.status);
      }
      return json({ detail: "Internal error", error: String(e?.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },
};

// Exported for tests (drive the cron handler directly against a seeded D1).
export { runScheduled };
