// Phase 6 security gate: mirrors server/tests/test_goal_security.py — JWT
// tamper/expiry rejection, password hashing never reversible, admin
// enforcement, and D1 query construction never concatenates user input.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createToken, decodeToken, hashPassword, verifyPassword } from "../auth.js";
import { call, login, setupEnv } from "./helpers/app.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("JWT", () => {
  it("a validly signed, unexpired token decodes to its payload", async () => {
    const token = await createToken("admin", true, "secret", 60);
    const payload = await decodeToken(token, "secret");
    expect(payload.sub).toBe("admin");
    expect(payload.admin).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createToken("admin", true, "secret-a", 60);
    expect(await decodeToken(token, "secret-b")).toBeNull();
  });

  it("rejects a tampered payload even if the signature segment is untouched", async () => {
    const token = await createToken("alice", false, "secret", 60);
    const [header, payload, sig] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "admin", admin: true, exp: payload.exp }))
      .toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${sig}`;
    expect(await decodeToken(tampered, "secret")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createToken("admin", true, "secret", -1); // already expired
    expect(await decodeToken(token, "secret")).toBeNull();
  });

  it("rejects malformed tokens (wrong segment count, garbage)", async () => {
    expect(await decodeToken("not-a-jwt", "secret")).toBeNull();
    expect(await decodeToken("a.b", "secret")).toBeNull();
    expect(await decodeToken("", "secret")).toBeNull();
    expect(await decodeToken(undefined, "secret")).toBeNull();
  });
});

describe("password hashing", () => {
  it("never stores the plaintext password", async () => {
    const stored = await hashPassword("admin");
    expect(stored).not.toContain("admin");
  });

  it("verifies the correct password and rejects wrong ones", async () => {
    const stored = await hashPassword("correct-password");
    expect(await verifyPassword("correct-password", stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("salts independently — hashing the same password twice differs", async () => {
    const a = await hashPassword("samepassword");
    const b = await hashPassword("samepassword");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("admin enforcement over HTTP", () => {
  it("a tampered/forged token is rejected by protected routes", async () => {
    const env = await setupEnv();
    const forged = await createToken("admin", true, "wrong-secret-entirely", 60);
    const r = await call(env, "GET", "/api/auth/users", { token: forged });
    expect(r.status).toBe(401);
  });

  it("an expired token is rejected by protected routes", async () => {
    const env = await setupEnv();
    const expired = await createToken("admin", true, env.PULSAR_SECRET_KEY, -1);
    const r = await call(env, "GET", "/api/watchlist", { token: expired });
    expect(r.status).toBe(401);
  });

  it("a non-admin token cannot reach admin-only routes", async () => {
    const env = await setupEnv();
    const adminToken = await login(env);
    await call(env, "POST", "/api/auth/users", { token: adminToken, body: { username: "eve", password: "pw" } });
    const eveToken = await login(env, "eve", "pw");
    expect((await call(env, "GET", "/api/auth/users", { token: eveToken })).status).toBe(403);
    expect((await call(env, "POST", "/api/auth/users", { token: eveToken, body: { username: "x", password: "y" } })).status).toBe(403);
    expect((await call(env, "DELETE", "/api/auth/users/admin", { token: eveToken })).status).toBe(403);
  });

  it("a token for a deleted user stays valid until expiry (matches Python: no token_version/per-request DB check)", async () => {
    const env = await setupEnv();
    const adminToken = await login(env);
    await call(env, "POST", "/api/auth/users", { token: adminToken, body: { username: "ghost", password: "pw" } });
    const ghostToken = await login(env, "ghost", "pw");
    await call(env, "DELETE", "/api/auth/users/ghost", { token: adminToken });
    // Pulsar has no token_version model (unlike panhandle) — get_current_user / decodeToken
    // only verify the JWT signature+exp, so a deleted user's still-unexpired token is honored
    // by design in both implementations. Re-login is what's actually blocked:
    expect((await call(env, "GET", "/api/watchlist", { token: ghostToken })).status).toBe(200);
    const relogin = await call(env, "POST", "/api/auth/login", { body: { username: "ghost", password: "pw" } });
    expect(relogin.status).toBe(401);
  });
});

describe("SQL injection surface", () => {
  it("db.js never builds SQL via string-concatenated user input", () => {
    const src = readFileSync(resolve(here, "../db.js"), "utf8");
    // Every prepare() call must use placeholders, not interpolate variables into the SQL text.
    const prepareCalls = src.match(/\.prepare\(\s*(`|")([\s\S]*?)\1\s*\)/g) || [];
    expect(prepareCalls.length).toBeGreaterThan(0);
    for (const call of prepareCalls) {
      expect(call, `unexpected template interpolation in: ${call}`).not.toMatch(/\$\{/);
    }
  });

  it("a coin_id / username containing SQL metacharacters is treated as inert data, not executed", async () => {
    const env = await setupEnv();
    const token = await login(env);
    const evil = "bitcoin'; DROP TABLE users; --";
    const r = await call(env, "POST", `/api/watchlist/${encodeURIComponent(evil)}`, { token });
    // Whatever the route's validation decides (200/404/etc), the users table must survive intact.
    expect(r.status).not.toBe(500);
    const stillWorks = await call(env, "GET", "/api/auth/users", { token });
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.body.some((u) => u.username === "admin")).toBe(true);
  });
});
