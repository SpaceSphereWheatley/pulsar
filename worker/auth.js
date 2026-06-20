// Auth — hand-rolled HS256 JWT + PBKDF2 password hashing via Web Crypto, no
// external deps. Mirrors panhandle's approach (Cloudflare has no bcrypt, so the
// original passlib/bcrypt hashes are replaced wholesale on this fresh D1).

const PBKDF2_ITERATIONS = 100_000;
const DEFAULT_EXPIRE_MINUTES = 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── base64url ─────────────────────────────────────────────────────────────────

function b64urlFromBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromString(str) {
  return b64urlFromBytes(enc.encode(str));
}
function bytesFromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function stringFromB64url(s) {
  return dec.decode(bytesFromB64url(s));
}

// ── HS256 JWT ─────────────────────────────────────────────────────────────────

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB = b64urlFromString(JSON.stringify(header));
  const payloadB = b64urlFromString(JSON.stringify(payload));
  const data = `${headerB}.${payloadB}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

// Returns the decoded payload, or null if signature/format/exp is invalid.
async function verifyJwt(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB, payloadB, sigB] = parts;
  const data = `${headerB}.${payloadB}`;
  const key = await hmacKey(secret);
  let ok;
  try {
    ok = await crypto.subtle.verify("HMAC", key, bytesFromB64url(sigB), enc.encode(data));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(stringFromB64url(payloadB));
  } catch {
    return null;
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
  return payload;
}

export async function createToken(username, isAdmin, secret, expireMinutes = DEFAULT_EXPIRE_MINUTES) {
  const exp = Math.floor(Date.now() / 1000) + expireMinutes * 60;
  return signJwt({ sub: username, admin: isAdmin, exp }, secret);
}

// decode_token equivalent: payload {sub, admin, exp} or null.
export async function decodeToken(token, secret) {
  return verifyJwt(token, secret);
}

// ── PBKDF2 password hashing ───────────────────────────────────────────────────
// Stored format: pbkdf2$<iterations>$<saltB64url>$<hashB64url>

export async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(plain, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlFromBytes(salt)}$${b64urlFromBytes(hash)}`;
}

export async function verifyPassword(plain, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = bytesFromB64url(parts[2]);
  const expected = bytesFromB64url(parts[3]);
  const actual = await pbkdf2(plain, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(plain, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(plain), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
