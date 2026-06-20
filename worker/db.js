// D1 data layer — replaces the JSON-file persistence (users/portfolio/history/
// watchlist) and the in-memory market caches (data.py) with SQL. All queries are
// parameterized via .bind() (no string interpolation → no SQL injection).

import { hashPassword, verifyPassword } from "./auth.js";
import { pyround } from "./series.js";

const SAFE_NAME_RE = /^[a-z0-9_-]{1,32}$/;

// ── Users ─────────────────────────────────────────────────────────────────────

// Idempotent admin seed (was users.seed_admin). Cheap existence check first so
// warm instances skip the hash. Safe to call at the top of every request.
let _seedChecked = false;
export async function ensureSeeded(env) {
  if (_seedChecked) return;
  const adminUser = env.PULSAR_ADMIN_USERNAME || "admin";
  const adminPass = env.PULSAR_ADMIN_PASSWORD || "admin";
  const row = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?1").bind(adminUser).first();
  if (!row) {
    const hashed = await hashPassword(adminPass);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (username, hashed_password, is_admin, created_by) VALUES (?1, ?2, 1, NULL)",
    )
      .bind(adminUser, hashed)
      .run();
  }
  _seedChecked = true;
}

// For tests that reset module state between DBs.
export function _resetSeedGuard() {
  _seedChecked = false;
}

export async function authenticate(env, username, password) {
  const rec = await env.DB.prepare(
    "SELECT username, hashed_password, is_admin FROM users WHERE username = ?1",
  )
    .bind(username)
    .first();
  if (!rec) return null;
  const ok = await verifyPassword(password, rec.hashed_password);
  if (!ok) return null;
  return { username: rec.username, is_admin: !!rec.is_admin };
}

export async function createUser(env, username, password, createdBy) {
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?1").bind(username).first();
  if (exists) throw new ValueErr(`User '${username}' already exists`);
  const hashed = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO users (username, hashed_password, is_admin, created_by) VALUES (?1, ?2, 0, ?3)",
  )
    .bind(username, hashed, createdBy)
    .run();
  return { username, is_admin: false };
}

export async function listUsers(env) {
  const { results } = await env.DB.prepare(
    "SELECT username, is_admin, created_at, created_by FROM users",
  ).all();
  return results.map((r) => ({
    username: r.username,
    is_admin: !!r.is_admin,
    created_at: r.created_at,
    created_by: r.created_by ?? null,
  }));
}

export async function changePassword(env, username, currentPassword, newPassword) {
  const rec = await env.DB.prepare("SELECT hashed_password FROM users WHERE username = ?1")
    .bind(username)
    .first();
  if (!rec) return false;
  if (!(await verifyPassword(currentPassword, rec.hashed_password))) return false;
  const hashed = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET hashed_password = ?2 WHERE username = ?1")
    .bind(username, hashed)
    .run();
  return true;
}

export async function deleteUser(env, username) {
  const rec = await env.DB.prepare("SELECT is_admin FROM users WHERE username = ?1").bind(username).first();
  if (!rec || rec.is_admin) return false; // admin cannot be deleted
  await env.DB.prepare("DELETE FROM users WHERE username = ?1").bind(username).run();
  return true;
}

// ── Portfolios ────────────────────────────────────────────────────────────────

export function safeName(name) {
  const n = String(name).trim().toLowerCase();
  if (!SAFE_NAME_RE.test(n)) {
    throw new ValueErr(
      "Portfolio name must be 1-32 lowercase alphanumeric, hyphens, or underscores",
    );
  }
  return n;
}

// Build the in-memory portfolio object (matches portfolio.load_portfolio shape).
// Returns the _empty() shape when no row exists (no row is created).
export async function loadPortfolioObj(env, username, name = "default") {
  const pf = await env.DB.prepare(
    "SELECT cash, total_deposited, total_withdrawn FROM portfolios WHERE username = ?1 AND name = ?2",
  )
    .bind(username, name)
    .first();
  if (!pf) {
    return { cash: 0.0, total_deposited: 0.0, total_withdrawn: 0.0, holdings: {}, transactions: [] };
  }
  const holdings = {};
  const { results: hrows } = await env.DB.prepare(
    "SELECT coin_id, amount, avg_buy_price FROM holdings WHERE username = ?1 AND portfolio_name = ?2",
  )
    .bind(username, name)
    .all();
  for (const h of hrows) holdings[h.coin_id] = { amount: h.amount, avg_buy_price: h.avg_buy_price };

  const { results: trows } = await env.DB.prepare(
    "SELECT seq, id, type, coin_id, amount, price, total, timestamp FROM transactions WHERE username = ?1 AND portfolio_name = ?2 ORDER BY seq ASC",
  )
    .bind(username, name)
    .all();
  const transactions = trows.map(rowToTransaction);

  return {
    cash: pf.cash,
    total_deposited: pf.total_deposited,
    total_withdrawn: pf.total_withdrawn,
    holdings,
    transactions,
  };
}

// Reproduce the stored JSON shape: deposit/withdrawal omit coin/amount/price.
function rowToTransaction(r) {
  if (r.type === "deposit" || r.type === "withdrawal") {
    return { id: r.id, type: r.type, total: r.total, timestamp: r.timestamp };
  }
  return {
    id: r.id,
    type: r.type,
    coin_id: r.coin_id,
    amount: r.amount,
    price: r.price,
    total: r.total,
    timestamp: r.timestamp,
  };
}

async function ensurePortfolioRow(env, username, name) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO portfolios (username, name, cash, total_deposited, total_withdrawn) VALUES (?1, ?2, 0, 0, 0)",
  )
    .bind(username, name)
    .run();
}

async function nextTxnSeq(env, username, name) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS m FROM transactions WHERE username = ?1 AND portfolio_name = ?2",
  )
    .bind(username, name)
    .first();
  return (row?.m ?? 0) + 1;
}

// Persist a full portfolio object back to D1 (cash/funds, holdings replace,
// transactions appended-only). Used by the trade/funds/reset endpoints after the
// (ported) Python mutation logic has run on the in-memory object.
export async function savePortfolioObj(env, username, name, pf) {
  await env.DB.prepare(
    "INSERT INTO portfolios (username, name, cash, total_deposited, total_withdrawn) VALUES (?1, ?2, ?3, ?4, ?5) " +
      "ON CONFLICT(username, name) DO UPDATE SET cash = ?3, total_deposited = ?4, total_withdrawn = ?5",
  )
    .bind(username, name, pf.cash, pf.total_deposited ?? 0, pf.total_withdrawn ?? 0)
    .run();

  // Replace holdings wholesale (simplest correct mirror of the JSON rewrite).
  await env.DB.prepare("DELETE FROM holdings WHERE username = ?1 AND portfolio_name = ?2")
    .bind(username, name)
    .run();
  for (const [coinId, h] of Object.entries(pf.holdings || {})) {
    await env.DB.prepare(
      "INSERT INTO holdings (username, portfolio_name, coin_id, amount, avg_buy_price) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(username, name, coinId, h.amount, h.avg_buy_price)
      .run();
  }

  // Transactions are append-only; insert any not already persisted (by seq).
  await env.DB.prepare("DELETE FROM transactions WHERE username = ?1 AND portfolio_name = ?2")
    .bind(username, name)
    .run();
  let seq = 0;
  for (const t of pf.transactions || []) {
    seq += 1;
    await env.DB.prepare(
      "INSERT INTO transactions (username, portfolio_name, seq, id, type, coin_id, amount, price, total, timestamp) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
      .bind(username, name, seq, t.id, t.type, t.coin_id ?? null, t.amount ?? null, t.price ?? null, t.total ?? null, t.timestamp)
      .run();
  }
}

export async function resetPortfolio(env, username, name = "default") {
  const fresh = { cash: 0.0, total_deposited: 0.0, total_withdrawn: 0.0, holdings: {}, transactions: [] };
  await savePortfolioObj(env, username, name, fresh);
  return fresh;
}

export async function listPortfolios(env, username) {
  const { results } = await env.DB.prepare(
    "SELECT name FROM portfolios WHERE username = ?1",
  )
    .bind(username)
    .all();
  const names = results.map((r) => r.name);
  const others = names.filter((n) => n !== "default").sort();
  const hasDefault = names.includes("default");
  if (hasDefault || others.length === 0) return ["default", ...others];
  return others;
}

export async function createPortfolio(env, username, name) {
  const safe = safeName(name);
  const exists = await env.DB.prepare("SELECT 1 FROM portfolios WHERE username = ?1 AND name = ?2")
    .bind(username, safe)
    .first();
  if (exists) throw new ValueErr(`Portfolio '${safe}' already exists`);
  await ensurePortfolioRow(env, username, safe);
  return { cash: 0.0, total_deposited: 0.0, total_withdrawn: 0.0, holdings: {}, transactions: [] };
}

export async function deletePortfolio(env, username, name) {
  const safe = safeName(name);
  if (safe === "default") throw new ValueErr("Cannot delete the default portfolio");
  const exists = await env.DB.prepare("SELECT 1 FROM portfolios WHERE username = ?1 AND name = ?2")
    .bind(username, safe)
    .first();
  if (!exists) throw new NotFoundErr(`Portfolio '${safe}' not found`);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM holdings WHERE username = ?1 AND portfolio_name = ?2").bind(username, safe),
    env.DB.prepare("DELETE FROM transactions WHERE username = ?1 AND portfolio_name = ?2").bind(username, safe),
    env.DB.prepare("DELETE FROM portfolio_history WHERE username = ?1 AND portfolio_name = ?2").bind(username, safe),
    env.DB.prepare("DELETE FROM portfolios WHERE username = ?1 AND name = ?2").bind(username, safe),
  ]);
}

// ── Portfolio history ─────────────────────────────────────────────────────────

export async function loadHistory(env, username, pfName = "default") {
  const { results } = await env.DB.prepare(
    "SELECT date, total_value, cash, pnl_pct FROM portfolio_history WHERE username = ?1 AND portfolio_name = ?2 ORDER BY date ASC",
  )
    .bind(username, pfName)
    .all();
  return results.map((r) => ({
    date: r.date,
    total_value: r.total_value,
    cash: r.cash,
    pnl_pct: r.pnl_pct,
  }));
}

// Upsert today's snapshot, keep most-recent 365 days (mirrors record_snapshot).
export async function recordSnapshot(env, username, totalValue, cash, pnlPct, pfName = "default", today = null) {
  const day = today || new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO portfolio_history (username, portfolio_name, date, total_value, cash, pnl_pct) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
      "ON CONFLICT(username, portfolio_name, date) DO UPDATE SET total_value = ?4, cash = ?5, pnl_pct = ?6",
  )
    .bind(username, pfName, day, pyround(totalValue, 2), pyround(cash, 2), pyround(pnlPct, 2))
    .run();
  // Trim to the newest 365 dates.
  await env.DB.prepare(
    "DELETE FROM portfolio_history WHERE username = ?1 AND portfolio_name = ?2 AND date NOT IN " +
      "(SELECT date FROM portfolio_history WHERE username = ?1 AND portfolio_name = ?2 ORDER BY date DESC LIMIT 365)",
  )
    .bind(username, pfName)
    .run();
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export async function loadWatchlist(env, username) {
  const { results } = await env.DB.prepare(
    "SELECT coin_id FROM watchlist WHERE username = ?1 ORDER BY seq ASC",
  )
    .bind(username)
    .all();
  return results.map((r) => r.coin_id);
}

export async function addCoin(env, username, coinId) {
  const exists = await env.DB.prepare("SELECT 1 FROM watchlist WHERE username = ?1 AND coin_id = ?2")
    .bind(username, coinId)
    .first();
  if (!exists) {
    const row = await env.DB.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS m FROM watchlist WHERE username = ?1",
    )
      .bind(username)
      .first();
    await env.DB.prepare("INSERT INTO watchlist (username, coin_id, seq) VALUES (?1, ?2, ?3)")
      .bind(username, coinId, (row?.m ?? 0) + 1)
      .run();
  }
  return loadWatchlist(env, username);
}

export async function removeCoin(env, username, coinId) {
  await env.DB.prepare("DELETE FROM watchlist WHERE username = ?1 AND coin_id = ?2")
    .bind(username, coinId)
    .run();
  return loadWatchlist(env, username);
}

// ── Market-data caches ────────────────────────────────────────────────────────

export async function getCoinsCache(env) {
  const { results } = await env.DB.prepare("SELECT coin_id, data, updated_at FROM coins_cache").all();
  if (results.length === 0) return { cache: {}, ts: 0 };
  const cache = {};
  let ts = 0;
  for (const r of results) {
    cache[r.coin_id] = JSON.parse(r.data);
    ts = Math.max(ts, r.updated_at);
  }
  return { cache, ts };
}

export async function setCoinsCache(env, coinsById, ts) {
  await env.DB.prepare("DELETE FROM coins_cache").run();
  for (const [coinId, coin] of Object.entries(coinsById)) {
    await env.DB.prepare("INSERT INTO coins_cache (coin_id, data, updated_at) VALUES (?1, ?2, ?3)")
      .bind(coinId, JSON.stringify(coin), ts)
      .run();
  }
}

export async function getOhlc(env, coinId) {
  const row = await env.DB.prepare("SELECT data FROM ohlc_cache WHERE coin_id = ?1").bind(coinId).first();
  return row ? JSON.parse(row.data) : null;
}

export async function setOhlc(env, coinId, data, ts) {
  await env.DB.prepare(
    "INSERT INTO ohlc_cache (coin_id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(coin_id) DO UPDATE SET data = ?2, updated_at = ?3",
  )
    .bind(coinId, JSON.stringify(data), ts)
    .run();
}

export async function getFeargreed(env) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM feargreed_cache WHERE id = 1").first();
  return row ? { data: JSON.parse(row.data), ts: row.updated_at } : { data: null, ts: 0 };
}

export async function setFeargreed(env, data, ts) {
  await env.DB.prepare(
    "INSERT INTO feargreed_cache (id, data, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2",
  )
    .bind(JSON.stringify(data), ts)
    .run();
}

export async function getNews(env) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM news_cache WHERE id = 1").first();
  return row ? { news: JSON.parse(row.data), ts: row.updated_at } : { news: [], ts: 0 };
}

export async function setNews(env, news, ts) {
  await env.DB.prepare(
    "INSERT INTO news_cache (id, data, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2",
  )
    .bind(JSON.stringify(news), ts)
    .run();
}

export async function getNokRate(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'nok_rate'").first();
  return row ? parseFloat(row.value) : 10.5; // fallback matches data.py
}

export async function setNokRate(env, rate, ts) {
  await env.DB.prepare(
    "INSERT INTO meta (key, value, updated_at) VALUES ('nok_rate', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2",
  )
    .bind(String(rate), ts)
    .run();
}

export async function getMlScores(env) {
  const { results } = await env.DB.prepare("SELECT coin_id, score, quality FROM ml_scores").all();
  const scores = {};
  const quality = {};
  for (const r of results) {
    scores[r.coin_id] = r.score;
    quality[r.coin_id] = r.quality;
  }
  return { scores, quality };
}

export async function setMlScores(env, byCoin, ts) {
  await env.DB.prepare("DELETE FROM ml_scores").run();
  for (const [coinId, sq] of Object.entries(byCoin)) {
    await env.DB.prepare("INSERT INTO ml_scores (coin_id, score, quality, updated_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(coinId, sq.score, sq.quality, ts)
      .run();
  }
}

// ── Typed errors so the router can map to the right HTTP status ────────────────

export class ValueErr extends Error {}
export class NotFoundErr extends Error {}
