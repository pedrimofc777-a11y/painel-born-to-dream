require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "256kb" }));
const PORT = process.env.PORT || 3000;
const GROUP_ID = process.env.ROBLOX_GROUP_ID || "190007685";
const API_KEY = process.env.ROBLOX_API_KEY || "";
const COOKIE_RAW = process.env.ROBLOX_COOKIE || "";
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
    const snap = loadJsonFile(SNAP_FILE, {});
    const lastSeen = snap.lastSaleId ? String(snap.lastSaleId) : null;
    const newOnes = [];
    for (const t of d.data.slice(0, 5)) {
      if (lastSeen && String(t.id) === lastSeen) break;
      newOnes.unshift(t);
    }
    snap.lastSaleId = String(d.data[0].id);
    saveJsonFile(SNAP_FILE, snap);
    if (!lastSeen) return;
    for (const t of newOnes.slice(-3)) {
      const a = getAsset(t);
      const agent = t.agent || {};
      const when = new Date(t.created).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const s = await sendWhats(`💰 VENDA NOVA\n${a.name} para ${agent.name || "?"} (${getRobux(t)})\n${when}`);
      console.log(`[whats] venda ${a.name} -> ${s.ok ? "ok" : s.error}`);
      await new Promise((rr) => setTimeout(rr, 5000));
    }
  } catch (e) { console.log("[wa-poll]", e.message); }
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

// cabeçalhos básicos de segurança
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

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
async function economyFetch(url, opts = {}) {
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
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...(hit.data), cached: true };
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

app.use(express.static(path.join(__dirname, "public")));

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
    const out = await cached("balance", 120000, async () => {
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
      await new Promise((rr) => setTimeout(rr, 1500)); // 1 tentativa extra
      r = await economyFetch(url.toString());
      d = await readJson(r);
    }
    if (!r.ok) return { error: { status: r.status, data: d } };
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
  const attl = dayKeys.length <= 7 ? 45000 : dayKeys.length <= 30 ? 120000 : 300000;
  const hitA = cache.get(akey);
  if (hitA && Date.now() - hitA.at < attl) return res.json({ ...hitA.data, cached: true });
  const sendA = (obj, ttl = null, diskKey = null) => {
    cache.set(akey, { at: Date.now(), data: obj });
    if (diskKey && obj.available && !obj.partial) {
      saveDiskCache({ [diskKey]: { at: Date.now(), data: obj } });
    }
    return res.json(obj);
  };
  try {
    const official = await cached("official", 60000, async () => {
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
    const pages = 15;
    const untilDate = new Date(dayKeys[0] + "T00:00:00");
    const got = await cached("salesR:" + dayKeys[0], 45000, () => fetchSalesPages(pages, untilDate));
    if (got.error) {
      const saved = loadDiskCache()[akey];
      if (saved) return res.json({ ...saved.data, stale: true });
      return sendA({ available: true, partial: true, days: dayKeys.length, official, sales: null, ticketMedio: null, byDay: [], byHour: [], transactions: [] }, 15000);
    }
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
    const salesList = inPeriod.slice(0, 1000).map((t) => {
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

    return sendA({
      available: true, days: dayKeys.length, range: label, today: todaySp,
      revenueToday, todayCount: todayTxs.length, revenuePeriod: totalRobux, official,
      sales, salesTotalRobux: totalRobux, ticketMedio, savedAt: new Date().toISOString(),
      byDay, byHour, transactions, salesList, ranking,
      todayList: todayTxs.slice(0, 200).map((t) => {
        const a = getAsset(t);
        return { id: t.id, created: t.created, robux: getRobux(t), assetName: a.name, assetId: a.id, buyerName: t.agent?.name || null, buyerId: t.agent?.id || null, buyerType: t.agent?.type || null };
      }),
    }, null, akey);
  } catch (e) {
    if (e.code === "NO_COOKIE") return res.status(503).json({ available: false, reason: e.message });
    const saved = loadDiskCache()[akey];
    if (saved) return res.json({ ...saved.data, stale: true });
    return res.status(500).json({ available: false, reason: "Falha interna." });
  }
});

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
    const out = await cached("latest", 25000, async () => {
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
// Robux a liberar (hold de ~30 dias): soma pendentes por data de liberação
app.get("/api/pending", async (req, res) => {
  try {
    const got = req.query.fresh
      ? await fetchSalesPages(5)
      : await cached("sales:10", 120000, () => fetchSalesPages(10));
    if (got.error) {
      const saved = loadDiskCache().pending;
      if (saved) return res.json({ ...saved.data, stale: true });
      return res.status(503).json({ error: "Dados indisponíveis." });
    }
    const rel = {};
    let pendingCount = 0;
    for (const t of got.txs) {
      if (!t.isPending) continue;
      pendingCount++;
      const created = new Date(t.created);
      const release = new Date(created.getTime() + 30 * 86400000);
      const k = spDateKey(release);
      rel[k] = (rel[k] || 0) + getRobux(t);
    }
    const today = spDateKey(new Date());
    // "cai amanhã": data de liberação da venda pendente mais antiga
    const sorted = Object.entries(rel).sort((a, b) => a[0].localeCompare(b[0]));
    const first = sorted[0] || null;
    const upcoming = sorted
      .filter(([k]) => k >= today)
      .slice(0, 7)
      .map(([date, robux]) => ({ date, robux }));
    const pendList = [];
    for (const t of got.txs) {
      if (!t.isPending) continue;
      const a = getAsset(t);
      const created = new Date(t.created);
      const release = new Date(created.getTime() + 30 * 86400000);
      pendList.push({ created: spDateKey(created), release: spDateKey(release), assetName: a.name, assetId: a.id, robux: getRobux(t) });
    }
    pendList.sort((a, b) => a.release.localeCompare(b.release));
    const out = {
      oldestDate: first ? first[0] : null,
      oldestRobux: first ? first[1] : 0,
      upcoming, pendingCount,
      totalPending: Object.values(rel).reduce((s, v) => s + v, 0),
      lastDate: sorted.length ? sorted[sorted.length - 1][0] : null,
      pendingRobux: upcoming.reduce((s, u) => s + u.robux, 0),
      items: pendList.slice(0, 200),
      savedAt: new Date().toISOString(),
    };
    saveDiskCache({ pending: { at: Date.now(), data: out } });
    return res.json(out);
  } catch {
    return res.status(500).json({ error: "Falha interna." });
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT} (grupo ${GROUP_ID})`);
  // pré-aquece o cache pesado (90 dias) para abrir rápido
  if (COOKIE_RAW) {
    const warm = async () => {
      try {
        const d = new Date(); d.setDate(d.getDate() - 89);
        const key = "salesR:" + spDateKey(d);
        const untilDate = new Date(spDateKey(d) + "T00:00:00");
        const got = await fetchSalesPages(15, untilDate);
        if (!got.error) cache.set(key, { at: Date.now(), data: got });
      } catch {}
    };
    setTimeout(warm, 8000);
    setInterval(warm, 10 * 60 * 1000);
  }
  // bot do Discord (comandos + avisos de venda)
  if (process.env.DISCORD_TOKEN && process.env.DISCORD_CHANNEL_ID) {
    try {
      require("./discord-bot")({
        port: PORT,
        token: process.env.DISCORD_TOKEN,
        channelId: process.env.DISCORD_CHANNEL_ID,
        guildId: process.env.DISCORD_GUILD_ID || "",
      });
    } catch (e) { console.log("[discord-bot]", e.message); }
  } else {
    console.log("Bot Discord: desligado (DISCORD_TOKEN/DISCORD_CHANNEL_ID)");
  }
  // avisos de venda no WhatsApp (CallMeBot)
  if (WA_PHONE.length && WA_APIKEY.length && COOKIE_RAW) {
    console.log(`WhatsApp: ok (${WA_PHONE.length} número(s))`);
    waPoll();
    setInterval(waPoll, 60 * 1000);
  } else {
    console.log("WhatsApp: desligado (WA_PHONE/WA_APIKEY)");
  }
});
