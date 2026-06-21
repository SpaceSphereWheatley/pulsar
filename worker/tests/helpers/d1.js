// Minimal D1 binding shim backed by node:sqlite, so the Worker's real SQL runs
// against a real SQLite engine in tests (high-fidelity, no Cloudflare deploy).
// Implements the subset of the D1 API the Worker uses: prepare().bind().first()/
// .all()/.run() and DB.batch().

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args);
  }
  async first(_col) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (row === undefined) return null;
    return row;
  }
  async all() {
    const results = this.db.prepare(this.sql).all(...this.params);
    return { results, success: true, meta: {} };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

class D1Shim {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts) {
    // D1 runs a batch in an implicit transaction; mirror that.
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

// Fresh in-memory DB with the migration applied. Returns the D1-like binding.
export function freshDb() {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(resolve(here, "../../../migrations/0001_init.sql"), "utf8");
  db.exec(schema);
  return new D1Shim(db);
}

// Build an `env` object for the Worker with the given overrides.
export function makeEnv(overrides = {}) {
  return {
    DB: freshDb(),
    PULSAR_SECRET_KEY: "test-secret-key",
    PULSAR_ADMIN_USERNAME: "admin",
    PULSAR_ADMIN_PASSWORD: "admin",
    PULSAR_TOKEN_EXPIRE_MINUTES: "60",
    ...overrides,
  };
}
