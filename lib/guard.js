/**
 * guard.js — autenticação, rate limit e cabeçalhos de segurança
 * Sem dependências externas (só node:crypto).
 */
const crypto = require("crypto");

const SECRET = process.env.PANEL_SECRET || process.env.ROBLOX_COOKIE || "born-to-dream-dev-secret";

/* ── sessão assinada (HMAC) ── */
function sign(value) {
  const sig = crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
  return `${value}.${sig}`;
}
function verify(token) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const value = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

const COOKIE_NAME = "btd_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSession(res, label) {
  const token = sign(`u|${label}|${crypto.randomBytes(6).toString("hex")}`);
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${MAX_AGE}`,
    ...(process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; "));
  return token;
}
function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** aceita cookie assinado OU header Authorization: Bearer <PANEL_PASS> (para API/script) */
function isAuthed(req) {
  const c = parseCookies(req.headers.cookie);
  const tok = verify(c[COOKIE_NAME]);
  if (tok && tok.startsWith("u|")) return true;
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ")) {
    const pass = process.env.PANEL_PASS || "";
    if (!pass) return false;
    const given = Buffer.from(h.slice(7).trim());
    const want = Buffer.from(pass);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }
  return false;
}

/** gate: tudo /api/* exige sessão, exceto a whitelist */
const OPEN_PATHS = ["/api/login", "/api/config", "/healthz"];
function authGate(req, res, next) {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/assets")) return next();
  if (OPEN_PATHS.includes(req.path)) return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "unauthorized", auth: true });
}

/* ── rate limit em memória ── */
function rateLimiter({ windowMs = 60000, max = 60, key = "rl" } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.first > windowMs) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
    const k = ip + ":" + key;
    const now = Date.now();
    let v = hits.get(k);
    if (!v || now - v.first > windowMs) { v = { n: 0, first: now }; hits.set(k, v); }
    v.n++;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - v.n)));
    if (v.n > max) {
      const retry = Math.ceil((windowMs - (now - v.first)) / 1000);
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ error: "Muitas requisições. Aguarde " + retry + "s.", retryAfter: retry });
    }
    next();
  };
}

/* ── cabeçalhos ── */
function secureHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api.ipify.org https://ipapi.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  next();
}

/** compara strings em tempo constante */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { sign, verify, setSession, clearSession, isAuthed, authGate, rateLimiter, secureHeaders, safeEqual };
