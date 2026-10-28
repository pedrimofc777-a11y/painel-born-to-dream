require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { log } = require("./lib/logger");
const guard = require("./lib/guard");
const store = require("./lib/store");
const { expo, delay } = require("./lib/backoff");
const L = log("server");

const app = express();
app.use(express.json({ limit: "256kb" }));
const PORT = process.env.PORT || 3000;
const GROUP_ID = process.env.ROBLOX_GROUP_ID || "190007685";
const API_KEY = process.env.ROBLOX_API_KEY || "";
const COOKIE_RAW = process.env.ROBLOX_COOKIE || "";
const PANEL_PASS = process.env.PANEL_PASS || "";
if (!PANEL_PASS && process.env.NODE_ENV === "production") {
  L.warn("PANEL_PASS não definido — defina uma senha no .env para proteger o painel");
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AI_PROVIDER = (process.env.AI_PROVIDER || "").toLowerCase();
const WA_PHONE = (process.env.WA_PHONE || "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);
const WA_APIKEY = (process.env.WA_APIKEY || "").split(",").map((s) => s.trim()).filter(Boolean);
// Cada número precisa da PRÓPRIA chave (ative cada um no bot, na mesma ordem).
// Ex: WA_PHONE=5511A,5522B + WA_APIKEY=chaveA,chaveB
async function sendWhats(text) {
  if (!WA_PHONE.length || !WA_APIKEY.length) return { ok: false, error: "no-config" };
  let ok = 0, err = null;
  for (let i = 0; i < WA_PHONE.length; i++) {
    const apikey = WA_APIKEY[i] || WA_APIKEY[0];
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${WA_PHONE[i]}&text=${encodeURIComponent(text.slice(0, 900))}&apikey=${apikey}`;
      const r = await fetch(url);
      const body = await r.text().catch(() => "");
      if (r.ok && !/error|not authorized|not allowed/i.test(body.slice(0, 200))) { ok++; }
      else { err = body.slice(0, 120) || ("http-" + r.status); console.log("[whats] erro", WA_PHONE[i], err); }
    } catch (e) { err = e.message; console.log("[whats] falha", e.message); }
    await new Promise((rr) => setTimeout(rr, 6000));
  }
  return ok ? { ok: true } : { ok: false, error: err };
}
async function waPoll() {
  if (!WA_PHONE.length || !WA_APIKEY.length || !COOKIE_RAW) return;
  try {
    const url = `https://economy.roblox.com/v2/groups/${encodeURIComponent(GROUP_ID)}/transactions?transactionType=Sale&limit=10`;
    const r = await economyFetch(url);
    const d = await readJson(r);
    if (!r.ok || !Array.isArray(d.data) || !d.data.length) return;
    const lastSeen = await store.read("lastSaleId", null);
    const newOnes = [];
    for (const t of d.data.slice(0, 5)) {
      if (lastSeen && String(t.id) === String(lastSeen)) break;
      newOnes.unshift(t);
    }
    await store.write("lastSaleId", String(d.data[0].id));
    if (!lastSeen) return;
    for (const t of newOnes.slice(-3)) {
      const a = getAsset(t);
      const agent = t.agent || {};
      const when = new Date(t.created).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const s = await sendWhats(`VENDA NOVA\n${a.name} para ${agent.name || "?"} (${getRobux(t)})\n${when}`);
      L.info("whats venda", { item: a.name, ok: s.ok, err: s.error });
      await new Promise((rr) => setTimeout(rr, 5000));
    }
  } catch (e) { L.warn("wa-poll", { err: e.message }); }
}
async function askFreeAI(message, ctx) {
  // Pollinations: IA gratuita, sem chave (https://pollinations.ai)
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    const snap = `Grupo Roblox ${ctx.gr.name || ""}: ${ctx.gr.memberCount ?? "?"} membros, dono ${ctx.gr.owner ? ctx.gr.owner.displayName : "?"}. 30d: ${ctx.ga.sales} vendas, ${ctx.ga.salesTotalRobux} total, ticket ${ctx.ga.ticketMedio}. Hoje: ${ctx.todayTx.length} vendas. Saldo ${ctx.ba.disponivel ?? "?"}, pendente ${ctx.ba.pendente ?? "?"}. Top: ${(ctx.ga.ranking || []).slice(0, 3).map((p) => `${p.name} (${p.vendas}x)`).join("; ")}.`;
    const prompt = `Responda em português, curto e direto, só com estes dados: ${snap} Pergunta: ${message}`;
    const r = await fetch("https://text.pollinations.ai/" + encodeURIComponent(prompt), { signal: ctrl.signal });
    clearTimeout(to);
    const t = (await r.text()).trim();
    return t ? t.slice(0, 900) : null;
  } catch { return null; }
}

// ── middlewares globais ──
app.use(guard.secureHeaders);
app.set("trust proxy", 1);
app.use(guard.rateLimiter({ windowMs: 60000, max: 300, key: "global" }));
// arquivos estáticos ANTES do auth (senão nem a tela de login carrega)
app.use(express.static(path.join(__dirname, "public")));
// login lento de propósito (anti força bruta)
app.use("/api/login", guard.rateLimiter({ windowMs: 300000, max: 12, key: "login" }));
// rotas que batem no Roblox / OpenAI: mais restritas
app.use("/api/analytics", guard.rateLimiter({ windowMs: 60000, max: 30, key: "analytics" }));
app.use("/api/chat", guard.rateLimiter({ windowMs: 60000, max: 12, key: "chat" }));
app.use("/api/chat-room", guard.rateLimiter({ windowMs: 60000, max: 20, key: "chatroom" }));
app.use("/api/members", guard.rateLimiter({ windowMs: 60000, max: 60, key: "members" }));
app.use("/api/members/search", guard.rateLimiter({ windowMs: 60000, max: 30, key: "search" }));
app.use("/api/user/lookup", guard.rateLimiter({ windowMs: 60000, max: 40, key: "lookup" }));
app.use("/api/product", guard.rateLimiter({ windowMs: 60000, max: 40, key: "product" }));
app.use("/api/pending", guard.rateLimiter({ windowMs: 60000, max: 20, key: "pending" }));
app.use("/api/access-log", guard.rateLimiter({ windowMs: 60000, max: 10, key: "accesslog" }));
// autenticação: tudo /api/* fechado, exceto whitelist
app.use(guard.authGate);

const DATA_DIR = path.join(__dirname, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
function loadDiskCache() { return loadJsonFile(CACHE_FILE, {}); }
function saveDiskCache(patch) {
  try {
    const c = loadJsonFile(CACHE_FILE, {});
    Object.assign(c, patch);
    const keys = Object.keys(c).filter((k) => k.startsWith("analytics:")).sort();
    while (keys.length > 4) delete c[keys.shift()];
    if (JSON.stringify(c).length > 2500000) {
      for (const k of Object.keys(c).filter((k) => k.startsWith("analytics:"))) delete c[k];
    }
    saveJsonFile(CACHE_FILE, c);
  } catch {}
}
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const SNAP_FILE = path.join(DATA_DIR, "snapshot.json");
const CHAT_FILE = path.join(DATA_DIR, "room.json");
// chat ao vivo do site (salvo no servidor, todos veem)
app.get("/api/chat-room", (req, res) => {
  const log = loadJsonFile(CHAT_FILE, []);
  const since = Number(req.query.since || 0);
  res.json({ messages: log.filter((m) => m.at > since).slice(-50) });
});
const chatRL = new Map();
app.post("/api/chat-room", (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();
  const now = Date.now();
  const t = chatRL.get(ip) || { n: 0, first: now };
  if (now - t.first > 10000) { t.n = 0; t.first = now; }
  t.n++; chatRL.set(ip, t);
  if (t.n > 5) return res.status(429).json({ error: "Devagar! Aguarde alguns segundos." });
  const body = req.body || {};
  const name = String(body.name || "").slice(0, 20).trim() || "Anônimo";
  const text = String(body.text || "").slice(0, 300).trim();
  if (!text) return res.status(400).json({ error: "Mensagem vazia." });
  const log = loadJsonFile(CHAT_FILE, []);
  log.push({ name, text, at: now });
  saveJsonFile(CHAT_FILE, log.slice(-100));
  res.json({ ok: true });
});

function loadJsonFile(f, fb) {
  try {
    if (!fs.existsSync(f)) return fb;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return fb; }
}
function saveJsonFile(f, v) {
  try { fs.writeFileSync(f, JSON.stringify(v, null, 1)); } catch {}
}
function logEvent(type, text, extra = {}) {
  const ev = loadJsonFile(EVENTS_FILE, []);
  ev.unshift({ at: new Date().toISOString(), type, text, ...extra });
  saveJsonFile(EVENTS_FILE, ev.slice(0, 300));
}

function spNow() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function buildCookieHeader() {
  const v = (COOKIE_RAW || "").trim();
  if (!v) return "";
  if (v.includes(".ROBLOSECURITY")) return v.includes("=") && v.includes(";") ? v : `.ROBLOSECURITY=${v.split("=").pop()}`;
  return `.ROBLOSECURITY=${v}`;
}

let csrfCache = "";
// fila única: 1 chamada autenticada por vez, com respiro (IP compartilhado sofre 429)
let ecoChain = Promise.resolve();
let ecoGap = 1200; // ajusta sozinho: sobe quando o Roblox reclama, desce quando tá calmo
let eco429 = 0;
function economyFetch(url, opts = {}) {
  const p = ecoChain.then(() => economyFetchInner(url, opts));
  ecoChain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, ecoGap)));
  return p;
}
async function economyFetchInner(url, opts = {}) {
  const cookie = buildCookieHeader();
  if (!cookie) {
    const e = new Error("Conexão com o Roblox indisponível no servidor.");
    e.code = "NO_COOKIE";
    throw e;
  }
  const doFetch = async (csrf) => {
    const headers = {
      Cookie: cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-TOKEN": csrf } : {}),
      ...(opts.headers || {}),
    };
    return fetch(url, { ...opts, headers });
  };
  let res = await doFetch(csrfCache);
  if (res.status === 429) {
    eco429++;
    ecoGap = Math.min(ecoGap * 1.5, 6000); // desacelera a fila inteira
    const wait = Math.min((parseFloat(res.headers.get("retry-after") || "5") || 5) * 1000, 30000);
    L.warn("429 do Roblox — desacelerando", { gapMs: Math.round(ecoGap), wait });
    await new Promise((r) => setTimeout(r, wait));
    res = await doFetch(csrfCache);
  } else if (eco429 > 0) {
    eco429--;
    if (eco429 === 0) ecoGap = Math.max(1200, ecoGap * 0.85); // volta a acelerar devagar
  }
  if (res.status === 403) {
    const newToken = res.headers.get("x-csrf-token");
    if (newToken) {
      csrfCache = newToken;
      res = await doFetch(newToken);
    }
  }
  return res;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
async function pubGet(url, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      const d = await readJson(r);
      if (r.ok) return { ok: true, data: d };
      last = { status: r.status, data: d };
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = { error: e.message }; }
    await new Promise((rr) => setTimeout(rr, 1500 * (i + 1)));
  }
  return { ok: false, ...(last || { error: "falha de rede" }) };
}
// cache curto: evita martelar o Roblox (que limita e devolve vazio)
const cache = new Map();
let cacheHits = 0, cacheMisses = 0;
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) { cacheHits++; return { ...(hit.data), cached: true }; }
  cacheMisses++;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return data;
}
function sumRevenue(summary = {}) {
  const keys = ["itemSaleRobux", "recurringRobuxStipend", "tradeSystemRobux", "purchasedRobux", "individualToGroupRobux"];
  return keys.reduce((a, k) => a + (Number(summary[k]) || 0), 0);
}
function getRobux(t = {}) {
  if (t.currency && typeof t.currency.amount !== "undefined") return Number(t.currency.amount) || 0;
  return Number(t.currencyAmount ?? t.robux ?? t.amount ?? 0) || 0;
}
function getAsset(t = {}) {
  const d = t.details || t.assetDetails || {};
  return { name: d.name || t.assetName || "Item", id: d.id ?? t.assetId ?? null };
}

/* contador de falhas seguidas por período (backoff) */
const partialFails = new Map();
setInterval(() => { if (partialFails.size > 40) partialFails.clear(); }, 10 * 60 * 1000).unref();

/* ── healthcheck (monitorar uptime) ── */app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    store: store.status(),
    cache: { mem: cache.size, hits: cacheHits, misses: cacheMisses },
    roblox: COOKIE_RAW ? "cookie-ok" : "sem-cookie",
    ia: !!(OPENAI_API_KEY || AI_PROVIDER),
  });
});

/* ─- login ── */
app.get("/api/me", (req, res) => {
  res.json({ authed: true, since: Date.now() });
});

app.post("/api/login", (req, res) => {
  const pass = String((req.body || {}).password || "");
  if (!PANEL_PASS) {
    return res.status(503).json({ error: "Painel sem senha configurada. Defina PANEL_PASS no .env e reinicie." });
  }
  if (!guard.safeEqual(pass, PANEL_PASS)) {
    L.warn("login falhou", { ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress });
    return res.status(401).json({ error: "Senha incorreta." });
  }
  guard.setSession(res, "painel");
  L.info("login ok", { ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress });
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  guard.clearSession(res);
  res.json({ ok: true });
});

/* ── metas configuráveis ── */
const DEFAULT_GOALS = { goals: [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000], period: 30 };
app.get("/api/goals", async (_req, res) => {
  const g = await store.read("goals", DEFAULT_GOALS);
  res.json(g && Array.isArray(g.goals) ? g : DEFAULT_GOALS);
});
app.put("/api/goals", async (req, res) => {
  const goals = (Array.isArray(req.body && req.body.goals) ? req.body.goals : [])
    .map((n) => Math.max(1, Math.min(1000000, Math.round(Number(n) || 0))))
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .slice(0, 20);
  const period = Math.max(1, Math.min(365, Math.round(Number((req.body || {}).period) || 30)));
  const saved = await store.write("goals", { goals, period });
  L.info("metas atualizadas", saved);
  res.json(saved);
});

/* ── exportar CSV (planilha de vendas) ── */
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get("/api/export/csv", async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const q = req.query.start && req.query.end ? `start=${req.query.start}&end=${req.query.end}` : `days=${days}`;
  try {
    const r = await fetch("http://127.0.0.1:" + PORT + "/api/analytics?" + q, { headers: { cookie: req.headers.cookie || "", authorization: req.headers.authorization || "" } });
    const a = await r.json();
    const rows = [["Data", "Hora", "Item", "ID do item", "Comprador", "ID do comprador", "Robux"]];
    (a.transactions || []).forEach((t) => {
      const d = new Date(t.created);
      const sp = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
      const g = (ty) => (sp.find((p) => p.type === ty) || {}).value || "";
      rows.push([
        `${g("day")}/${g("month")}/${g("year")}`,
        `${g("hour")}:${g("minute")}`,
        t.assetName || "", t.assetId || "", t.buyerName || "", t.buyerId || "", getRobux(t),
      ]);
    });
    const csv = "\uFEFF" + rows.map((r2) => r2.map(csvCell).join(";")).join("\r\n");
    const fname = `vendas-${q.replace(/[^a-z0-9=]/gi, "-")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.send(csv);
    L.info("csv exportado", { rows: rows.length - 1, q });
  } catch (e) {
    res.status(500).json({ error: "Falha ao gerar CSV: " + e.message });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({ groupId: GROUP_ID });
});

// ---------- grupo ----------
app.get("/api/group", async (_req, res) => {
  let openCloud = null;
  if (API_KEY) {
    try {
      const r = await fetch(
        `https://apis.roblox.com/cloud/v2/groups/${encodeURIComponent(GROUP_ID)}`,
        { headers: { "x-api-key": API_KEY, Accept: "application/json" } }
      );
      const data = await readJson(r);
      if (r.ok) openCloud = data;
    } catch {}
  }
  try {
    const g = await pubGet(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}`);
    if (!g.ok) {
      const saved = loadDiskCache().group;
      if (saved) return res.json({ ...saved.data, stale: true });
      return res.status(g.status || 500).json({ error: "Grupo não encontrado." });
    }
    const data = g.data;
    const out = {
      id: String(data.id), displayName: data.name, name: data.name,
      memberCount: data.memberCount, description: data.description,
      owner: data.owner, shout: data.shout, savedAt: new Date().toISOString(),
    };
    saveDiskCache({ group: { at: Date.now(), data: out } });
    return res.json(out);
  } catch (e) {
    const saved = loadDiskCache().group;
    if (saved) return res.json({ ...saved.data, stale: true });
    return res.status(500).json({ error: "Falha ao falar com o Roblox." });
  }
});

app.get("/api/roles", async (_req, res) => {
  try {
    const data = await cached("roles", 600000, async () => {
      const g = await pubGet(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/roles`);
      if (!g.ok) return { error: true };
      return g.data;
    });
    if (data.error) return res.status(503).json({ error: "Falha ao listar cargos." });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Falha ao falar com o Roblox." });
  }
});

app.get("/api/members", async (req, res) => {
  const roleId = req.query.roleId;
  if (!roleId) return res.status(400).json({ error: "Informe o cargo." });
  const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10) || 50, 10), 100);
  const cursor = req.query.cursor || "";
  try {
    const url = new URL(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/roles/${encodeURIComponent(roleId)}/users`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url.toString());
    const data = await readJson(r);
    if (!r.ok) return res.status(r.status).json({ error: "Falha ao listar membros." });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Falha ao falar com o Roblox." });
  }
});

// Pesquisa global sem precisar escolher cargo: varre os cargos e filtra por nome.
app.get("/api/members/search", async (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase().trim();
  if (q.length < 2) return res.status(400).json({ error: "Digite ao menos 2 letras." });
  try {
    const rr = await fetch(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/roles`);
    const roles = await readJson(rr);
    const out = [];
    for (const role of (roles.roles || [])) {
      let cursor = "";
      for (let p = 0; p < 6 && out.length < 60; p++) {
        const url = new URL(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/roles/${role.id}/users`);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
        const r = await fetch(url.toString());
        const d = await readJson(r);
        if (!r.ok) break;
        for (const u of (d.data || [])) {
          if ((u.username || "").toLowerCase().includes(q) || (u.displayName || "").toLowerCase().includes(q)) {
            out.push({ userId: u.userId, username: u.username, displayName: u.displayName, role: role.name, roleId: role.id });
            if (out.length >= 60) break;
          }
        }
        cursor = d.nextPageCursor || "";
        if (!cursor) break;
      }
      if (out.length >= 60) break;
    }
    return res.json({ q: req.query.q, results: out });
  } catch {
    return res.status(500).json({ error: "Falha ao pesquisar." });
  }
});

// Registro oficial do grupo (cargos, postagens etc.) — usa a sessão do servidor.
app.get("/api/audit", async (req, res) => {
  try {
    const url = new URL(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/audit-log`);
    url.searchParams.set("limit", String(Math.min(parseInt(req.query.limit || "25", 10) || 25, 100)));
    if (req.query.cursor) url.searchParams.set("cursor", req.query.cursor);
    if (req.query.actionType) url.searchParams.set("actionType", req.query.actionType);
    const cookie = buildCookieHeader();
    if (!cookie) return res.status(503).json({ error: "Registro indisponível no momento." });
    let r = await fetch(url.toString(), { headers: { Cookie: cookie, Accept: "application/json" } });
    if (r.status === 403) {
      const tk = r.headers.get("x-csrf-token");
      if (tk) r = await fetch(url.toString(), { headers: { Cookie: cookie, Accept: "application/json", "X-CSRF-TOKEN": tk } });
    }
    const d = await readJson(r);
    if (!r.ok) return res.status(r.status).json({ error: "Sem permissão para o registro oficial.", details: d });
    return res.json(d);
  } catch {
    return res.status(500).json({ error: "Falha ao buscar registro." });
  }
});

// Eventos locais (entradas/saídas detetadas + produtos novos)
app.get("/api/events", (_req, res) => {
  res.json({ events: loadJsonFile(EVENTS_FILE, []) });
});

// Saldo do grupo: disponível + pendente (sessão do servidor)
app.get("/api/balance", async (_req, res) => {
  try {
    const out = await cached("balance", 300000, async () => {
      const r = await economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/currency`);
      const cur = await readJson(r);
      if (!r.ok) return { error: true };
      const m = await economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/Month`);
      const sum = await readJson(m);
      return {
        disponivel: Number(cur.robux) || 0,
        pendente: Number(sum.pendingRobux) || 0,
      };
    });
    if (out.error) {
      const saved = loadDiskCache().balance;
      if (saved) return res.json({ ...saved.data, stale: true });
      return res.status(503).json({ error: "Saldo indisponível no momento." });
    }
    saveDiskCache({ balance: { at: Date.now(), data: out } });
    return res.json(out);
  } catch (e) {
    if (e.code === "NO_COOKIE") return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: "Falha interna." });
  }
});

// Perfil completo de 1 pessoa (público): id, nomes, bio, conta, amizades
app.get("/api/user/lookup", async (req, res) => {
  const q = (req.query.q || "").toString().trim().replace(/^@/, "");
  if (!q) return res.status(400).json({ error: "Digite um nome ou ID." });
  try {
    let id = /^\d+$/.test(q) ? q : null;
    if (!id) {
      const r = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [q], excludeBannedUsers: false }),
      });
      const d = await readJson(r);
      if (!r.ok || !d.data || !d.data.length) return res.status(404).json({ error: "Usuário não encontrado." });
      id = String(d.data[0].id);
    }
    const [u, friends, followers, followings] = await Promise.all([
      readJson(await fetch(`https://users.roblox.com/v1/users/${id}`)),
      readJson(await fetch(`https://friends.roblox.com/v1/users/${id}/friends/count`)).catch(() => ({})),
      readJson(await fetch(`https://friends.roblox.com/v1/users/${id}/followers/count`)).catch(() => ({})),
      readJson(await fetch(`https://friends.roblox.com/v1/users/${id}/followings/count`)).catch(() => ({})),
    ]);
    if (!u || !u.id) return res.status(404).json({ error: "Usuário não encontrado." });
    let avatar = null;
    try {
      const ar = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${u.id}&size=150x150&format=Png&isCircular=false`);
      const ad = await readJson(ar);
      if (ad.data && ad.data[0]) avatar = ad.data[0].imageUrl || null;
    } catch {}
    return res.json({
      id: u.id, username: u.name, displayName: u.displayName,
      bio: u.description || "", created: u.created,
      banned: Boolean(u.isBanned), verified: Boolean(u.hasVerifiedBadge),
      friends: friends.count ?? null, followers: followers.count ?? null, following: followings.count ?? null,
      avatar, profile: `https://www.roblox.com/users/${u.id}/profile`,
    });
  } catch {
    return res.status(500).json({ error: "Falha ao buscar perfil." });
  }
});
// ---------- receita / transações ----------
app.get("/api/revenue/:timeFrame", async (req, res) => {
  const tf = req.params.timeFrame;
  if (!["Day", "Week", "Month", "Year"].includes(tf)) {
    return res.status(400).json({ error: "Período inválido." });
  }
  try {
    const r = await economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/${tf}`);
    const data = await readJson(r);
    if (!r.ok) return res.status(r.status).json({ error: "Dados indisponíveis no momento." });
    return res.json({ timeFrame: tf, total: sumRevenue(data), ...data });
  } catch (e) {
    if (e.code === "NO_COOKIE") return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: "Falha interna." });
  }
});

const VALID_TX = new Set(["Sale", "Payout", "AffiliateSale", "GroupPayout", "AdImpression", "AdClick", "PremiumPayout", "RecurringPayment", "RevenueShare"]);
app.get("/api/transactions", async (req, res) => {
  const transactionType = req.query.transactionType || "Sale";
  const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10) || 100, 1), 100);
  const cursor = req.query.cursor || "";
  if (!VALID_TX.has(transactionType)) return res.status(400).json({ error: "Tipo inválido." });
  try {
    const url = new URL(`https://economy.roblox.com/v2/groups/${encodeURIComponent(GROUP_ID)}/transactions`);
    url.searchParams.set("transactionType", transactionType);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await economyFetch(url.toString());
    const data = await readJson(r);
    if (!r.ok) return res.status(r.status).json({ error: "Dados indisponíveis no momento." });
    return res.json(data);
  } catch (e) {
    if (e.code === "NO_COOKIE") return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: "Falha interna." });
  }
});

function spDateKey(d) {
  try { return new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); }
  catch { return new Date(d).toISOString().slice(0, 10); }
}
function spHour(d) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).formatToParts(new Date(d));
    return (parseInt((parts.find((p) => p.type === "hour") || {}).value || "0", 10) || 0) % 24;
  } catch { return new Date(d).getHours(); }
}
function spWeekdayShort(dateKey) {
  try {
    return new Date(dateKey + "T12:00:00").toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short" }).replace(".", "");
  } catch { return ""; }
}

async function fetchSalesPages(maxPages = 10, untilDate = null) {
  const txs = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`https://economy.roblox.com/v2/groups/${encodeURIComponent(GROUP_ID)}/transactions`);
    url.searchParams.set("transactionType", "Sale");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    let r = await economyFetch(url.toString());
    let d = await readJson(r);
    if (!r.ok && [429, 500, 502, 503].includes(r.status)) {
      await new Promise((rr) => setTimeout(rr, 4000)); // 1 tentativa extra
      r = await economyFetch(url.toString());
      d = await readJson(r);
    }
    if (!r.ok) {
      /* NÃO é tudo-ou-nada: se já coletamos páginas, devolve o que temos
         marcado como parcial. Um 429 na página 12 não pode zerar as 11 anteriores. */
      if (txs.length > 0) {
        L.warn("vendas parcial: falha na página " + (page + 1) + "/" + maxPages, { status: r.status, txs: txs.length });
        return { txs, partial: true, status: r.status };
      }
      return { error: { status: r.status, data: d } };
    }
    const items = Array.isArray(d.data) ? d.data : [];
    for (const t of items) txs.push(t);
    cursor = d.nextPageCursor || "";
    if (!cursor) break;
    // para cedo: já passou do início do filtro
    if (untilDate && items.length) {
      const last = new Date(items[items.length - 1].created);
      if (!isNaN(last) && last < untilDate) break;
    }
  }
  return { txs };
}

// GET /api/analytics?days=7 | ?start=2026-09-01&end=2026-10-07
/* ═══════════ dedupe: 1 busca em voo por chave (evita rajada de rede) ═══════════ */
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
const FULL_TTL = 60 * 1000; // 60s: mesmo ritmo de 1 minuto que funcionava antes
let fullSaleErr = null;
const refreshing = new Set(); // akeys com refresh em voo (evita rajada no cold start)
/**
 * Bus grande ÚNICA: 25 páginas de vendas, sem parar cedo.
 * analytics, pendente e produto derivam dela — evita as 3 buscas separadas
 * que cavavam 429. Mas o TTL é de 60s: o painel atualiza a cada 1 minuto,
 * que é o tempo que o Roblox aguenta sem limitar.
 */
function salesFull() {
  return once("sales:full", () => fetchSalesPages(25, null));
}
/** atualiza em 2º plano: nunca bloqueia quem pediu dado */
function refreshSalesInBackground() {
  if (inflight.has("sales:full")) return; // já tem uma busca em voo
  salesFull().then((data) => {
    if (data.error) { fullSaleErr = data.error; L.warn("refresh de vendas falhou", { status: data.error.status }); }
    else { cache.set("sales:full", { at: Date.now(), data }); fullSaleErr = null; }
  }).catch(() => {});
}
/**
 * Busca grande com cache, padrão stale-while-revalidate:
 *  - dado fresco (TTL)  -> devolve na hora;
 *  - dado velho         -> devolve na hora e REFRESHA em 2º plano;
 *  - nada               -> busca e espera (só no primeiro acesso).
 * Um erro NUNCA sobrescreve um dado bom no cache (senão o painel "esvazia").
 */
async function salesCached() {
  const hit = cache.get("sales:full");
  const now = Date.now();
  if (hit && now - hit.at < FULL_TTL) return hit.data;
  if (!hit) {
    const data = await salesFull(); // frio: sem o que servir, precisa esperar
    if (!data.error) { cache.set("sales:full", { at: now, data }); fullSaleErr = null; }
    else fullSaleErr = data.error;
    return data;
  }
  refreshSalesInBackground();
  return { ...hit.data, stale: true };
}

app.get("/api/analytics", async (req, res) => {
  if (!COOKIE_RAW) {
    return res.status(503).json({ available: false, reason: "Conexão com o Roblox indisponível no servidor." });
  }
  let dayKeys = [];
  let label = "";
  if (req.query.start && req.query.end) {
    const s = new Date(req.query.start + "T12:00:00"), e = new Date(req.query.end + "T12:00:00");
    if (isNaN(s) || isNaN(e) || e < s) return res.status(400).json({ error: "Datas inválidas." });
    const diff = Math.min(Math.round((e - s) / 86400000) + 1, 90);
    for (let i = 0; i < diff; i++) {
      const d = new Date(s); d.setDate(s.getDate() + i);
      dayKeys.push(spDateKey(d));
    }
    label = `${req.query.start} → ${req.query.end}`;
  } else {
    let days = parseInt(req.query.days || "7", 10);
    if (isNaN(days) || days < 1) days = 7;
    if (days > 90) days = 90;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      dayKeys.push(spDateKey(d));
    }
    label = `${dayKeys.length} dias`;
  }
  const akey = "analytics:" + (req.query.start && req.query.end ? req.query.start + "_" + req.query.end : "d" + dayKeys.length);
  const attl = dayKeys.length <= 7 ? 60000 : dayKeys.length <= 30 ? 180000 : 300000;
  const hitA = cache.get(akey);
  if (hitA && Date.now() - hitA.at < attl) return res.json({ ...hitA.data, cached: true });

  /* padrão stale-while-revalidate: se existe QUALQUER dado salvo (memória ou
     disco), entrega na hora e atualiza em 2º plano. Só bloqueia quando não há
     nada (primeiro acesso). Assim o bot/painel nunca fica 30-150s preso. */
  const staleObj = hitA ? hitA.data : (await store.read(akey, null));
  if (staleObj && staleObj.available) {
    cache.set(akey, { at: Date.now(), data: staleObj });
    refreshAnalytics(akey, dayKeys, label).catch(() => {});
    return res.json({ ...staleObj, stale: true });
  }
  /* cold start (nada salvo ainda): NÃO bloqueia. Dispara a busca em 2º plano e
     devolve "parcial" imediato — o painel mostra "Sincronizando" e refaz em
     instantes; o bot responde na hora em vez de travar 30-150s no Roblox. */
  if (!refreshing.has(akey)) {
    refreshing.add(akey);
    refreshAnalytics(akey, dayKeys, label).finally(() => refreshing.delete(akey)).catch(() => {});
  }
  return res.json({
    available: true, partial: true, sales: null, days: dayKeys.length, range: label,
    official: null, byDay: [], byHour: [], transactions: [], salesList: [], ranking: [], todayList: [],
    retryAfter: 20000,
  });
});

/* busca os dados do Roblox e monta o payload. usado pela rota e pelo refresh em 2o plano */
async function refreshAnalytics(akey, dayKeys, label) {
  const fails = partialFails.get(akey) || 0;
  try {
  const official = await cached("official", 180000, async () => {
      const [dayR, weekR, monthR] = await Promise.all([
        economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/Day`),
        economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/Week`),
        economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/Month`),
      ]);
      return {
        day: dayR.ok ? sumRevenue(await readJson(dayR)) : null,
        week: weekR.ok ? sumRevenue(await readJson(weekR)) : null,
        month: monthR.ok ? sumRevenue(await readJson(monthR)) : null,
      };
    });
    const pages = 25;
    const got = await salesCached();
    if (got.error) {
      L.warn("falha ao buscar vendas", { status: got.error.status });
      partialFails.set(akey, fails + 1);
      const wait = expo(fails, 15000, 300000);
      const out = { available: true, partial: true, days: dayKeys.length, range: label, official, sales: null, ticketMedio: null, byDay: [], byHour: [], transactions: [], txError: got.error.status || "?", retryAfter: wait };
      cache.set(akey, { at: Date.now(), data: out });
      return out;
    }
    partialFails.delete(akey);
    partialFails.delete(akey);
    const txs = got.txs;
    const set = new Set(dayKeys);
    const todaySp = spDateKey(new Date());
    const inPeriod = txs.filter((t) => set.has(spDateKey(t.created)));
    const todayTxs = txs.filter((t) => spDateKey(t.created) === todaySp);
    const sales = inPeriod.length;
    const totalRobux = inPeriod.reduce((a, t) => a + getRobux(t), 0);
    const revenueToday = todayTxs.reduce((a, t) => a + getRobux(t), 0);
    const ticketMedio = sales ? Math.round((totalRobux / sales) * 100) / 100 : 0;
    const byDayMap = Object.fromEntries(dayKeys.map((k) => [k, 0]));
    inPeriod.forEach((t) => {
      const k = spDateKey(t.created);
      if (k in byDayMap) byDayMap[k] += getRobux(t);
    });
    const byDay = dayKeys.map((k) => ({ date: k, label: `${k.slice(8, 10)}/${k.slice(5, 7)}`, weekday: spWeekdayShort(k), robux: byDayMap[k] || 0 }));
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, "0")}h`, robux: 0 }));
    todayTxs.forEach((t) => { byHour[spHour(t.created)].robux += getRobux(t); });
    const transactions = txs.slice(0, 100).map((t) => {
      const a = getAsset(t);
      return { id: t.id, created: t.created, robux: getRobux(t), assetName: a.name, assetId: a.id, buyerName: t.agent?.name || null, buyerId: t.agent?.id || null, buyerType: t.agent?.type || null };
    });
    const salesList = inPeriod.map((t) => {
      const a = getAsset(t);
      return { id: t.id, created: t.created, robux: getRobux(t), assetName: a.name, assetId: a.id, buyerName: t.agent?.name || null, buyerId: t.agent?.id || null, buyerType: t.agent?.type || null };
    });
    const rankMap = {};
    inPeriod.forEach((t) => {
      const a = getAsset(t);
      const key = `${a.id}|||${a.name}`;
      rankMap[key] = rankMap[key] || { name: a.name, assetId: a.id, vendas: 0, robux: 0, days: {}, buyers: [] };
      rankMap[key].vendas += 1;
      rankMap[key].robux += getRobux(t);
      const dk = spDateKey(t.created);
      rankMap[key].days[dk] = (rankMap[key].days[dk] || 0) + getRobux(t);
      if (rankMap[key].buyers.length < 10 && t.agent?.name) rankMap[key].buyers.push({ name: t.agent.name, id: t.agent.id || null, at: t.created });
    });
    const ranking = Object.values(rankMap).sort((a, b) => b.robux - a.robux).slice(0, 10);

    // produtos vistos: só registra em silêncio (o aviso de item novo sai pela venda real, no vigia)
    try {
      const snap = loadJsonFile(SNAP_FILE, { products: [] });
      const known = new Set(snap.products || []);
      for (const p of ranking) {
        if (p.assetId && !known.has(String(p.assetId))) {
          logEvent("produto", `Novo item à venda: ${p.name}`, { assetId: p.assetId });
          known.add(String(p.assetId));
        }
      }
      snap.products = [...known].slice(-300);
      snap.at = new Date().toISOString();
      saveJsonFile(SNAP_FILE, snap);
    } catch {}

    const out = {
      available: true, days: dayKeys.length, range: label, today: todaySp,
      revenueToday, todayCount: todayTxs.length, revenuePeriod: totalRobux, official,
      sales, salesTotalRobux: totalRobux, ticketMedio, savedAt: new Date().toISOString(),
      byDay, byHour, transactions, salesList, ranking,
      todayList: todayTxs.slice(0, 500).map((t) => {
        const a = getAsset(t);
        return { id: t.id, created: t.created, robux: getRobux(t), assetName: a.name, assetId: a.id, buyerName: t.agent?.name || null, buyerId: t.agent?.id || null, buyerType: t.agent?.type || null };
      }),
    };
    // grava em memória + disco + KV (se ligado)
    cache.set(akey, { at: Date.now(), data: out });
    saveDiskCache({ [akey]: { at: Date.now(), data: out } });
    store.write(akey, out).catch(() => {});
    return out;
  } catch (e) {
    if (e && e.code === "NO_COOKIE") {
      const err = new Error(e.message); err.code = "NO_COOKIE"; throw err;
    }
    L.warn("analytics falhou", { err: e && e.message });
    throw e;
  }
}

// Universos (experiências) do grupo + passes de jogo — só leitura pública
app.get("/api/universes", async (_req, res) => {
  try {
    const r = await fetch(`https://games.roblox.com/v2/groups/${encodeURIComponent(GROUP_ID)}/games?limit=50`);
    const d = await readJson(r);
    if (!r.ok) return res.status(r.status).json({ error: "Falha ao listar universos." });
    return res.json({ data: (d.data || []).map((g) => ({ universeId: g.id, name: g.name })) });
  } catch {
    return res.status(500).json({ error: "Falha interna." });
  }
});
app.get("/api/game-passes", async (req, res) => {
  const universeId = req.query.universeId;
  if (!universeId) return res.status(400).json({ error: "Informe universeId." });
  try {
    const r = await fetch(`https://games.roblox.com/v1/games/${encodeURIComponent(universeId)}/game-passes?limit=100`);
    const d = await readJson(r);
    if (!r.ok) return res.status(r.status).json({ error: "Falha ao listar passes." });
    return res.json(d);
  } catch {
    return res.status(500).json({ error: "Falha interna." });
  }
});
// Leitura rápida (5 últimas vendas) para o site detetar venda nova sem recarregar tudo
app.get("/api/latest", async (_req, res) => {
  try {
    const out = await cached("latest", 45000, async () => {
      const url = `https://economy.roblox.com/v2/groups/${encodeURIComponent(GROUP_ID)}/transactions?transactionType=Sale&limit=10`;
      const r = await economyFetch(url);
      const d = await readJson(r);
      if (!r.ok) return { error: true };
      return {
        firstId: d.data && d.data[0] ? d.data[0].id : null,
        count: (d.data || []).length,
        today: spDateKey(new Date()),
      };
    });
    if (out.error) return res.status(503).json({ error: "Indisponível." });
    return res.json(out);
  } catch (e) {
    if (e.code === "NO_COOKIE") return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: "Falha interna." });
  }
});
/** pendente OFICIAL do Roblox (resumo do mês) — bate com o valor do grupo.
 *  O valor do cartão vem daqui: é um saldo, não depende das páginas que o 429
 *  deixa de entregar (a soma das transações flutuava: 42k -> 30k -> ...). */
async function officialPendingRobux() {
  const o = await cached("sum:pending", 300000, async () => {
    const r = await economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/Month`);
    if (!r.ok) return { robux: null };
    const s = await readJson(r);
    return { robux: Number(s.pendingRobux) || 0 };
  });
  return o && o.robux != null ? o.robux : null;
}
/** aplica o valor OFICIAL ao payload e destrava a contagem (estimada pela
 *  média de preço das pendentes parciais — a paginação do 429 capava em 2499). */
function applyOfficialPending(out, auth) {
  if (auth == null) return out;
  const media = out.pendingCount > 0 && out.pendingRobux > 0 ? out.pendingRobux / out.pendingCount : 0;
  out.pendingRobux = auth;
  out.totalPending = auth;
  out.oficial = true;
  if (media > 0) out.pendingCount = Math.max(out.pendingCount, Math.round(auth / media));
  return out;
}

// Robux a liberar (hold de ~30 dias): agrupa por DATA DE LIBERAÇÃO
// venda do dia 10 -> cai no dia 10 do mes seguinte. Mostra o pendente mais proximo.
app.get("/api/pending", async (req, res) => {
  // só devolve salvo na hora se tiver menos de 3 min (senão espera o fresco,
  // que é o ritmo de 1 minuto que o Roblox aguenta)
  if (!req.query.fresh) {
    const saved = await store.read("pending", null);
    if (saved && saved.data && saved.data.savedAt && Date.now() - new Date(saved.data.savedAt).getTime() < 3 * 60 * 1000) {
      res.json(saved.data);
      return;
    }
  }
  try {
    /* valor OFICIAL do Roblox (1 chamada cacheada de 5 min) — é um saldo, então
       não sofre o 429 nem "abaixa" sozinho como a soma das transações fazia. */
    const auth = await officialPendingRobux();
    const got = req.query.fresh ? await salesFull() : await salesCached();
    if (got.error) {
      /* sem transações agora: ainda devolve o valor oficial (não mostra 0 nem trava). */
      if (auth != null) {
        const out = { pendingRobux: auth, totalPending: auth, pendingCount: 0, upcoming: [], porData: [], oficial: true, stale: true, retryAfter: 60000 };
        await store.write("pending", { at: Date.now(), data: out });
        return res.json(out);
      }
      const saved = await store.read("pending", null);
      if (saved && saved.data) return res.json({ ...saved.data, stale: true, retryAfter: 60000 });
      return res.status(503).json({ error: "Dados indisponíveis agora (limite do Roblox).", retryAfter: 60000 });
    }
    const out = buildPending(got.txs);
    /* contagem: a paginação do 429 só entrega ~2500 transações, então a soma
       parcial "trava" em 2499 e não bate com os 45k. applyOfficialPending põe o
       valor oficial e destrava a contagem (estimada pelo preço médio). */
    applyOfficialPending(out, auth);
    await store.write("pending", { at: Date.now(), data: out });
    return res.json(out);
  } catch (e) {
    if (e && e.code === "NO_COOKIE") {
      const saved = await store.read("pending", null);
      if (saved && saved.data) return res.json({ ...saved.data, stale: true, noCookie: true });
      return res.status(503).json({ error: "Cookie do Roblox não configurado no servidor.", noCookie: true });
    }
    L.warn("pending falhou", { err: e && e.message });
    const saved = await store.read("pending", null);
    if (saved && saved.data) return res.json({ ...saved.data, stale: true });
    return res.status(500).json({ error: "Falha interna." });
  }
});

/** recalcula pendentes/previsão e guarda (usado pelo boot) */
async function refreshPending() {
  const got = await salesCached();
  if (got.error) throw Object.assign(new Error("roblox indisponível"), { code: "ROBLOX" });
  const out = buildPending(got.txs);
  applyOfficialPending(out, await officialPendingRobux());
  await store.write("pending", { at: Date.now(), data: out });
  return out;
}

/** monta o payload de pendentes/previsão a partir das transações */
function buildPending(txs) {
    const now = new Date();
    const rel = {};
    let pendingCount = 0, pendingRobux = 0;
    const pendList = [];
    for (const t of txs) {
      if (!t.isPending) continue;
      pendingCount++;
      const robux = getRobux(t);
      pendingRobux += robux;
      const created = new Date(t.created);
      const release = new Date(created.getTime() + 30 * 86400000);
      const k = spDateKey(release);
      rel[k] = (rel[k] || 0) + robux;
      pendList.push({ created: spDateKey(created), release: k, assetName: getAsset(t).name, assetId: getAsset(t).id, robux });
    }
    const today = spDateKey(now);
    const future = Object.entries(rel).filter(([k]) => k >= today).sort((a, b) => a[0].localeCompare(b[0]));
    const past = Object.entries(rel).filter(([k]) => k < today).sort((a, b) => b[0].localeCompare(a[0]));
    const proximo = future[0] || past[0] || null;
    const daysTo = proximo ? Math.round((new Date(proximo[0] + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000) : null;
    const upcoming = future.slice(0, 8).map(([date, robux]) => ({ date, robux }));
    return {
      oldestDate: proximo ? proximo[0] : null,
      oldestRobux: proximo ? proximo[1] : 0,
      upcoming, pendingCount, totalPending: pendingRobux, pendingRobux,
      lastDate: future.length ? future[future.length - 1][0] : (past.length ? past[0][0] : null),
      proximo: proximo ? { date: proximo[0], robux: proximo[1], emDias: daysTo } : null,
      atrasado: past.length ? { date: past[0][0], robux: past[0][1] } : null,
      porData: [...future.slice(0, 12), ...past.slice(0, 4)].map(([date, robux]) => ({ date, robux, futuro: date >= today })),
      items: pendList,
      savedAt: new Date().toISOString(),
    };
}

/* ── log de acesso (lista pro comando /ips) ── */
app.get("/api/access-log", async (req, res) => {
  const log = await store.read("accessLog", []);
  res.json({ items: log.slice(0, 30) });
});

/* ── log de acesso (avisa no Discord quando alguem entra no painel) ── */
app.post("/api/access-log", async (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "?").slice(0, 180);
  const page = String((req.body || {}).page || "/").slice(0, 60);
  const when = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  res.json({ ok: true });
  L.info("acesso ao painel", { ip, page });
  try {
    const log = await store.read("accessLog", []);
    log.unshift({ ip, ua, page, when });
    await store.write("accessLog", log.slice(0, 200));
  } catch {}
  if (global.__btdNotifyAccess) {
    setTimeout(() => { try { global.__btdNotifyAccess({ ip, ua, page, when }); } catch {} }, 300);
  }
});

// Vendas de um produto (dias + compradores)
app.get("/api/product/:assetId/sales", async (req, res) => {
  try {
    const got = await cached("sales:10", 180000, () => fetchSalesPages(10));
    if (got.error) return res.status(503).json({ error: "Dados indisponíveis." });
    const id = String(req.params.assetId);
    let list = got.txs.filter((t) => String(getAsset(t).id) === id);
    let range = "todo o tempo";
    if (req.query.start && req.query.end) {
      range = `${req.query.start} → ${req.query.end}`;
      list = list.filter((t) => { const k = spDateKey(t.created); return k >= req.query.start && k <= req.query.end; });
    } else if (req.query.days) {
      let days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
      const cut = new Date(); cut.setDate(cut.getDate() - (days - 1));
      const startK = spDateKey(cut);
      range = `${days} dias`;
      list = list.filter((t) => spDateKey(t.created) >= startK);
    }
    const byDay = {};
    const buyers = list.map((t) => ({ name: t.agent?.name || "—", id: t.agent?.id || null, at: t.created, robux: getRobux(t) }));
    list.forEach((t) => {
      const k = spDateKey(t.created);
      byDay[k] = byDay[k] || { date: k, vendas: 0, robux: 0 };
      byDay[k].vendas += 1; byDay[k].robux += getRobux(t);
    });
    const a = list.length ? getAsset(list[0]) : { name: "Item", id };
    return res.json({ assetId: id, name: a.name, range, vendas: list.length, robux: list.reduce((s, t) => s + getRobux(t), 0), byDay: Object.values(byDay).sort((x, y) => x.date.localeCompare(y.date)), buyers: buyers.slice(0, 100) });
  } catch {
    return res.status(500).json({ error: "Falha interna." });
  }
});

// Análise completa do dia (a assistente mostra no painel)
async function buildDaily(dateKey) {
  const got = await fetchSalesPages(5);
  if (got.error) return { error: true };
  const txs = got.txs;
  const y = new Date(dateKey + "T12:00:00"); y.setDate(y.getDate() - 1);
  const yKey = spDateKey(y);
  const today = txs.filter((t) => spDateKey(t.created) === dateKey);
  const yest = txs.filter((t) => spDateKey(t.created) === yKey);
  const sum = (l) => l.reduce((s, t) => s + getRobux(t), 0);
  const hours = Array.from({ length: 24 }, () => 0);
  today.forEach((t) => { hours[spHour(t.created)] += getRobux(t); });
  const bh = hours.indexOf(Math.max(...hours, 0));
  const rk = {};
  today.forEach((t) => { const a = getAsset(t); const k = String(a.id) + a.name; rk[k] = rk[k] || { name: a.name, vendas: 0, robux: 0 }; rk[k].vendas++; rk[k].robux += getRobux(t); });
  const top = Object.values(rk).sort((a, b) => b.robux - a.robux)[0] || null;
  return {
    date: dateKey, sales: today.length, total: sum(today),
    ticket: today.length ? Math.round((sum(today) / today.length) * 100) / 100 : 0,
    ySales: yest.length, yTotal: sum(yest),
    bestHour: today.length ? `${String(bh).padStart(2, "0")}h` : null,
    top, distinct: Object.keys(rk).length,
  };
}
app.get("/api/daily-summary", async (req, res) => {
  const d = await buildDaily(req.query.date || spDateKey(new Date()));
  if (d.error) return res.status(503).json({ error: "Dados indisponíveis." });
  res.json(d);
});
// IA real (opcional): se OPENAI_API_KEY estiver no .env, responde com contexto vivo do grupo
async function askAI(history, message, ctx) {
  if (!OPENAI_API_KEY) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    const snap = {
      grupo: ctx.gr.name || null, membros: ctx.gr.memberCount ?? null,
      dono: ctx.gr.owner ? `${ctx.gr.owner.displayName} (@${ctx.gr.owner.username})` : null,
      vendas30d: ctx.ga.sales, total30d: ctx.ga.salesTotalRobux, ticket: ctx.ga.ticketMedio,
      hoje: { vendas: ctx.todayTx.length, total: ctx.todayTx.reduce((s, t) => s + getRobux(t), 0) },
      saldo: ctx.ba.disponivel ?? null, pendente: ctx.ba.pendente ?? null,
      top: (ctx.ga.ranking || []).slice(0, 5).map((p) => `${p.name} (${p.vendas}x, ${p.robux})`),
      ultima: ctx.last ? `${ctx.last.assetName} para ${ctx.last.buyerName} em ${ctx.last.created} (${ctx.last.robux})` : null,
    };
    const msgs = [
      { role: "system", content: "Você é a assistente do painel Born to Dream (grupo Roblox, valores em Robux, horário America/Sao_Paulo). Responda em português, curto e direto, usando SÓ os dados abaixo. Se não souber, diga. Dados: " + JSON.stringify(snap) },
      ...(Array.isArray(history) ? history.slice(-6).map((m) => ({ role: m.role === "u" ? "user" : "assistant", content: String(m.text || "").slice(0, 500) })) : []),
      { role: "user", content: message.slice(0, 500) },
    ];
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_API_KEY },
      body: JSON.stringify({ model: OPENAI_MODEL, messages: msgs, max_tokens: 300, temperature: 0.3 }),
    });
    clearTimeout(to);
    const d = await readJson(r);
    const txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    return txt ? txt.trim().slice(0, 900) : null;
  } catch { return null; }
}
// Conversa com a assistente (usa os números reais do grupo)
app.post("/api/chat", async (req, res) => {
  const raw = ((req.body || {}).message || "").toString();
  const q = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const has = (...words) => words.some((w) => q.includes(w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  try {
    const got = await fetchSalesPages(10);
    const txs = got.txs || [];
    const cutoff = spDateKey(new Date(Date.now() - 30 * 86400000));
    const m30 = txs.filter((t) => spDateKey(t.created) >= cutoff);
    const ga = {
      sales: m30.length,
      salesTotalRobux: m30.reduce((s, t) => s + getRobux(t), 0),
      transactions: txs.slice(0, 5).map((t) => { const a = getAsset(t); return { assetName: a.name, buyerName: (t.agent || {}).name, created: t.created, robux: getRobux(t) }; }),
    };
    ga.ticketMedio = ga.sales ? Math.round((ga.salesTotalRobux / ga.sales) * 100) / 100 : 0;
    const dayMap = {};
    m30.forEach((t) => { const k = spDateKey(t.created); dayMap[k] = (dayMap[k] || 0) + getRobux(t); });
    ga.byDay = Object.entries(dayMap).map(([date, robux]) => ({ date, weekday: spWeekdayShort(date), robux })).sort((a, b) => b.robux - a.robux);
    const rk = {};
    m30.forEach((t) => { const a = getAsset(t); const k = String(a.id) + a.name; rk[k] = rk[k] || { name: a.name, vendas: 0, robux: 0 }; rk[k].vendas++; rk[k].robux += getRobux(t); });
    ga.ranking = Object.values(rk).sort((a, b) => b.robux - a.robux);
    let gr = {};
    try { gr = await readJson(await fetch(`https://groups.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}`)); } catch {}
    let ba = { disponivel: null, pendente: null };
    try {
      const cr = await economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/currency`);
      const cur = await readJson(cr);
      ba.disponivel = Number(cur.robux) || 0;
      const mr = await economyFetch(`https://economy.roblox.com/v1/groups/${encodeURIComponent(GROUP_ID)}/revenue/summary/Month`);
      const msum = await readJson(mr);
      ba.pendente = Number(msum.pendingRobux) || 0;
    } catch { ba = { disponivel: null, pendente: null }; }
    // pendente mais antigo (base do "cai amanhã")
    const pend = txs.filter((t) => t.isPending).sort((a, b) => new Date(a.created) - new Date(b.created));
    const oldestPend = pend[0] || null;
    const oldestRelease = oldestPend ? spDateKey(new Date(new Date(oldestPend.created).getTime() + 30 * 86400000)) : null;
    const todaySp = spDateKey(new Date());
    const todayTx = txs.filter((t) => spDateKey(t.created) === todaySp);
    const best = (ga.byDay || [])[0];
    const top = (ga.ranking || [])[0];
    const last = (ga.transactions || [])[0];
    if (!q.trim()) return res.json({ reply: "O que quer saber sobre o grupo?" });
    if (OPENAI_API_KEY) {
      const ai = await askAI(req.body.history || [], raw, { ga, gr, ba, todayTx, best, top, last });
      if (ai) return res.json({ reply: ai, ia: true });
    }
    if (AI_PROVIDER === "pollinations") {
      const ai = await askFreeAI(raw, { ga, gr, ba, todayTx });
      if (ai) return res.json({ reply: ai, ia: true });
    }
    if (has("ultim") && has("venda")) {
      const t = (ga.transactions || [])[0];
      if (!t) return res.json({ reply: "Ainda não encontrei vendas recentes." });
      const dt = new Date(t.created).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return res.json({ reply: `A última venda foi "${t.assetName}" para ${t.buyerName || "?"} às ${dt}, no valor de ${t.robux}.` });
    }
    if (has("saldo", "disponível", "disponivel", "quanto tem", "caixa")) {
      if (ba.disponivel == null) return res.json({ reply: "Não consegui ver o saldo agora. Tente de novo em instantes." });
      return res.json({ reply: `O grupo tem ${ba.disponivel} disponíveis e ${ba.pendente ?? "?"} pendentes.` });
    }
    if (has("pendente", "quando cai", "quando libera", "libera", "caira", "cairá", "receber", "liberação", "liberacao") || (has("cai", "cair") && has("robux", "venda", "dia", "quando"))) {
      if (!oldestPend) return res.json({ reply: "Não há vendas pendentes no momento." });
      const a = getAsset(oldestPend);
      const sameDay = pend.filter((t) => spDateKey(new Date(new Date(t.created).getTime() + 30 * 86400000)) === oldestRelease);
      const tot = sameDay.reduce((s, t) => s + getRobux(t), 0);
      return res.json({ reply: `A liberação mais próxima é ${oldestRelease}: ${tot} de ${sameDay.length} venda(s) (a mais antiga é "${a.name}"). No total há ${pend.length} vendas pendentes.` });
    }
    if (has("ontem")) {
      const y = new Date(); y.setDate(y.getDate() - 1);
      const yKey = spDateKey(y);
      const yl = txs.filter((t) => spDateKey(t.created) === yKey);
      const yt = yl.reduce((s, t) => s + getRobux(t), 0);
      return res.json({ reply: `Ontem (${yKey}) foram ${yl.length} vendas somando ${yt}.` });
    }
    if (has("quem mais comprou", "melhor cliente", "maior comprador", "top comprador")) {
      const buyers = {};
      m30.forEach((t) => { const n = (t.agent || {}).name || "?"; buyers[n] = buyers[n] || { name: n, id: (t.agent || {}).id, vendas: 0, robux: 0 }; buyers[n].vendas++; buyers[n].robux += getRobux(t); });
      const tb = Object.values(buyers).sort((a, b) => b.robux - a.robux)[0];
      return res.json({ reply: tb ? `Quem mais comprou nos últimos 30 dias foi ${tb.name} (${tb.vendas}x, ${tb.robux} no total).` : "Sem vendas nos últimos 30 dias." });
    }
    if (has("pior dia", "dia ruim", "dia fraco")) {
      const w = (ga.byDay || [])[0] ? [...ga.byDay].sort((x, y) => x.robux - y.robux)[0] : null;
      return res.json({ reply: w ? `O pior dia dos últimos 30 dias foi ${w.date} (${w.weekday}) com ${w.robux}.` : "Ainda sem dados suficientes." });
    }
    if (has("menos vendido", "vende menos", "pior item", "pior produto")) {
      const w = [...(ga.ranking || [])].sort((a, b) => a.robux - b.robux)[0];
      return res.json({ reply: w ? `O item mais fraco dos últimos 30 dias é "${w.name}" (${w.vendas}x, ${w.robux}).` : "Sem vendas nos últimos 30 dias." });
    }
    if (has("essa semana", "esta semana", "7 dias", "ultimos 7")) {
      return res.json({ reply: `Nos últimos 7 dias: use o filtro "7 dias" na Dashboard. Nos últimos 30 dias foram ${ga.sales} vendas somando ${ga.salesTotalRobux}.` });
    }
    if (has("ajuda", "help", "o que voce sabe", "o que você sabe", "comandos")) {
      return res.json({ reply: "Sei responder: última venda, vendas de hoje/ontem, melhor e pior dia, top e pior produto, quem mais comprou, saldo e pendentes, quando libera, membros, dono e resumo geral." });
    }
    if (has("resumo", "como está", "como esta", "situação", "situacao", "geral")) {
      return res.json({ reply: `Resumo: ${gr.name || "grupo"} com ${gr.memberCount ?? "?"} membros. 30 dias: ${ga.sales} vendas, ${ga.salesTotalRobux} no total, ticket ${ga.ticketMedio}. Saldo: ${ba.disponivel ?? "?"} disponíveis e ${ba.pendente ?? "?"} pendentes. Top item: ${top ? `"${top.name}" (${top.vendas} vendas)` : "—"}.` });
    }
    if (has("membro", "quantos", "tamanho")) {
      return res.json({ reply: `O grupo ${gr.name || ""} tem ${gr.memberCount ?? "?"} membros. O dono é ${gr.owner ? gr.owner.displayName + " (@" + gr.owner.username + ")" : "desconhecido"}.` });
    }
    if (has("dono", "owner", "criador")) {
      return res.json({ reply: gr.owner ? `O dono é ${gr.owner.displayName} (@${gr.owner.username}).` : "Não consegui ver o dono agora." });
    }
    if (has("produto", "item", "mais vendido", "top")) {
      if (!top) return res.json({ reply: "Sem vendas nos últimos 30 dias." });
      return res.json({ reply: `O item mais vendido dos últimos 30 dias é "${top.name}" com ${top.vendas} vendas e ${top.robux} no total.` });
    }
    if (has("ticket", "médio", "medio", "preço", "preco")) {
      return res.json({ reply: `Ticket médio dos últimos 30 dias: ${ga.ticketMedio ?? "?"} por venda, em ${ga.sales ?? "?"} vendas.` });
    }
    if ((has("que dia") || has("qual a data") || has("data de hoje")) && !has("cai", "cair", "libera", "pendente")) {
      return res.json({ reply: `Hoje é ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })}.` });
    }
    if (has("hoje", "dia de hoje") && !has("horario") && !has("horário") && !has("hora")) {
      return res.json({ reply: `Hoje já foram ${todayTx.reduce((s, t) => s + getRobux(t), 0)} em ${todayTx.length} vendas.` });
    }
    if (has("melhor", "dia bom", "quando")) {
      return res.json({ reply: best ? `O melhor dia dos últimos 30 dias foi ${best.date} (${best.weekday}) com ${best.robux}.` : "Ainda sem dados suficientes." });
    }
    if (has("caiu", "queda", "pior", "deca", "erro", "ruim", "piora")) {
      return res.json({ reply: "Abra a aba Assistente: ela compara as metades do período e aponta queda em %, dia zerado e concentração num item só. Quedas costumam vir de item fora do ar, preço alterado ou falta de divulgação no melhor horário." });
    }
    if (has("hora", "horario", "horário")) {
      if (has("ultim")) {
        if (!last) return res.json({ reply: "Ainda não encontrei vendas recentes." });
        const dt = new Date(last.created).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        return res.json({ reply: `A última venda foi às ${dt}: "${last.assetName}" para ${last.buyerName || "?"} (${last.robux}).` });
      }
      const hours = Array.from({ length: 24 }, () => 0);
      todayTx.forEach((t) => {
        try {
          const h = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(new Date(t.created)), 10) || 0;
          hours[h % 24] += getRobux(t);
        } catch {}
      });
      const tot = hours.reduce((s, v) => s + v, 0);
      if (!tot) return res.json({ reply: "Sem vendas hoje ainda." });
      const bh = hours.indexOf(Math.max(...hours));
      return res.json({ reply: `O melhor horário de hoje foi ${String(bh).padStart(2, "0")}h com ${hours[bh]}.` });
    }
    if (has("o que vendeu hoje", "vendeu hoje")) {
      const items = {};
      todayTx.forEach((t) => { const a = getAsset(t); items[a.name] = (items[a.name] || 0) + 1; });
      const top3 = Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} (${c}x)`).join(", ");
      return res.json({ reply: todayTx.length ? `Hoje: ${todayTx.length} vendas — ${top3}.` : "Nenhuma venda hoje ainda." });
    }
    if (has("projecao", "previsao", "fim do mes", "fechar o mes")) {
      const nowSp = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
      const day = nowSp.getDate(), dim = new Date(nowSp.getFullYear(), nowSp.getMonth() + 1, 0).getDate();
      const pace = ga.salesTotalRobux / Math.max(day, 1) * dim;
      return res.json({ reply: `No ritmo atual (${ga.salesTotalRobux} em ${day} dias), o mês fecharia com cerca de ${Math.round(pace)}.` });
    }
    if (has("comparar", "comparado", "diferenca", "evolucao")) {
      const days = ga.byDay || [];
      const h = Math.floor(days.length / 2);
      const s1 = days.slice(0, h).reduce((s, d) => s + d.robux, 0), s2 = days.slice(h).reduce((s, d) => s + d.robux, 0);
      return res.json({ reply: `Primeira metade: ${s1}. Segunda metade: ${s2} (${s2 >= s1 ? "+" : ""}${s2 - s1}).` });
    }
    if (has("top 3", "3 mais")) {
      const t3 = (ga.ranking || []).slice(0, 3).map((p, i) => `${i + 1}. ${p.name} (${p.vendas}x)`);
      return res.json({ reply: t3.length ? "Top 3: " + t3.join(" • ") : "Sem vendas no período." });
    }
    if (has("quantos itens", "quantos produtos")) {
      return res.json({ reply: `${(ga.ranking || []).length} itens diferentes vendidos nos últimos 30 dias.` });
    }
    if (has("venda", "vendeu", "total", "fatur")) {
      return res.json({ reply: `Últimos 30 dias: ${ga.sales ?? "?"} vendas somando ${ga.salesTotalRobux ?? "?"}.` });
    }
    if (has("oi", "ola", "olá", "bom dia", "boa", "e ai", "e aí")) {
      return res.json({ reply: "Olá! Pergunte sobre saldo, membros, dono, produtos, ticket médio, melhor dia ou vendas de hoje." });
    }
    return res.json({ reply: "Posso responder sobre: última venda, hoje/ontem, melhor e pior dia, top 3, quem mais comprou, saldo, pendentes, quando libera, projeção do mês, membros, dono e resumo. O que quer saber?" });
  } catch { return res.json({ reply: "Tive um problema ao buscar os números. Tente de novo em instantes." }); }
});

/* 404 de API antes do catch-all (evita HTML com 200 em rota inexistente) */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Rota não encontrada: " + req.path });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  L.info(`dashboard no ar em http://localhost:${PORT}`, { grupo: GROUP_ID, store: store.status() });
  store.syncFromKV(["goals", "snapshot", "events", "pending", "analytics:d1", "analytics:d7", "analytics:d30"]).then((n) => {
    if (n) L.info("espelho KV sincronizado", { chaves: n });
  }).catch(() => {});
  // bot do Discord (comandos + avisos de venda + IP de acesso)
  const tok = !!process.env.DISCORD_TOKEN, ch = !!process.env.DISCORD_CHANNEL_ID;
  if (tok && ch) {
    L.info("bot do Discord: iniciando", { guild: process.env.DISCORD_GUILD_ID ? "sim" : "nao (comandos globais)" });
    try {
      require("./discord-bot")({
        port: PORT,
        token: process.env.DISCORD_TOKEN,
        channelId: process.env.DISCORD_CHANNEL_ID,
        guildId: process.env.DISCORD_GUILD_ID || "",
        panelPass: PANEL_PASS,
      });
    } catch (e) { L.error("bot do Discord falhou ao iniciar", { err: e.message }); }
  } else {
    L.warn("bot do Discord desligado", { temToken: tok, temCanal: ch });
  }
  // UMA busca grande no boot alimenta analytics + pendente + produto.
  // antes eram 3 buscas separadas (40+ requisições seguidas) e cavava 429 no Roblox.
  if (COOKIE_RAW) {
    const boot = async () => {
      const t0 = Date.now();
      const got = await salesCached();
      if (got.error) { L.warn("aquecendo: Roblox recusou", { status: got.error.status }); return; }
      const n = got.txs.length;
      try { await refreshPending(); L.info("pendentes calculados no boot", { ms: Date.now() - t0 }); }
      catch (e) { L.warn("pendentes no boot falharam", { err: e.message }); }
      L.info("cache aquecido", { vendas: n, ms: Date.now() - t0 });
      // reaquecer depois que o Roblox respira (5 min = TTL do cache)
      setInterval(async () => {
        try {
          const g = await salesCached();
          if (!g.error) await refreshPending();
        } catch {}
      }, 5 * 60 * 1000);
    };
    setTimeout(boot, 2500);
  }
  // avisos de venda no WhatsApp (CallMeBot)
  if (WA_PHONE.length && WA_APIKEY.length && COOKIE_RAW) {
    L.info(`WhatsApp: ok (${WA_PHONE.length} número(s))`);
    setTimeout(waPoll, 60000);
    setInterval(waPoll, 60 * 1000); // 1 minuto: pega a venda rapido sem martelar
  } else {
    console.log("WhatsApp: desligado (WA_PHONE/WA_APIKEY)");
  }
});
