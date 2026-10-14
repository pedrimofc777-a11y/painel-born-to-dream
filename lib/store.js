/**
 * store.js — persistência com disco + espelho opcional externo (Upstash Redis REST)
 * Resolve o disco efêmero do Render: se KV_REST_API_URL/KV_REST_API_TOKEN
 * estiverem no .env, o espelho externo é usado como fonte da verdade.
 * Sem dependências externas (só fetch nativo do Node 18+).
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const STORE_FILE = path.join(DATA_DIR, "store.json");

const URL_ = (process.env.KV_REST_API_URL || "").replace(/\/$/, "");
const TOKEN = process.env.KV_REST_API_TOKEN || "";
const KV_ON = !!(URL_ && TOKEN);
const PREFIX = (process.env.KV_PREFIX || "btd:") || "btd:";

const mem = new Map();
let disk = {};
try { disk = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch { disk = {}; }

let writeChain = Promise.resolve();

function flushDisk() {
  writeChain = writeChain.then(() => {
    try {
      const tmp = STORE_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(disk, null, 1));
      fs.renameSync(tmp, STORE_FILE);
    } catch (e) { /* disco cheio/só-leitura: o espelho externo cobre */ }
  });
  return writeChain;
}

async function kvCmd(...args) {
  if (!KV_ON) return null;
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error("kv http " + r.status);
  return (await r.json()).result;
}

async function kvGet(key) {
  const raw = await kvCmd("GET", PREFIX + key);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}
async function kvSet(key, value) {
  await kvCmd("SET", PREFIX + key, JSON.stringify(value));
}

/**
 * read(key, fallback) — memória → disco → espelho externo
 */
async function read(key, fallback = null) {
  if (mem.has(key)) return mem.get(key);
  if (Object.prototype.hasOwnProperty.call(disk, key)) {
    const v = disk[key];
    mem.set(key, v);
    return v;
  }
  if (KV_ON) {
    try {
      const v = await kvGet(key);
      if (v !== undefined && v !== null) {
        mem.set(key, v);
        disk[key] = v;
        flushDisk();
        return v;
      }
    } catch (e) { /* cai para o fallback */ }
  }
  return fallback;
}

/** read síncrono (usa só memória/disco) — para rotinas de boot */
function readSync(key, fallback = null) {
  if (mem.has(key)) return mem.get(key);
  if (Object.prototype.hasOwnProperty.call(disk, key)) return disk[key];
  return fallback;
}

/** write(key, value) — memória + disco + espelho externo */
async function write(key, value) {
  mem.set(key, value);
  disk[key] = value;
  flushDisk();
  if (KV_ON) {
    try { await kvSet(key, value); }
    catch (e) {
      const { log } = require("./logger");
      log.mk("store").warn("espelho KV falhou", { key, err: e.message });
    }
  }
  return value;
}

/** remove(key) */
async function del(key) {
  mem.delete(key);
  delete disk[key];
  flushDisk();
  if (KV_ON) { try { await kvCmd("DEL", PREFIX + key); } catch {} }
}

/** pull do espelho para a memória (chamado no boot) */
async function syncFromKV(keys) {
  if (!KV_ON) return 0;
  let n = 0;
  for (const k of keys) {
    try {
      const v = await kvGet(k);
      if (v !== undefined && v !== null && !mem.has(k)) { mem.set(k, v); disk[k] = v; n++; }
    } catch {}
  }
  if (n) flushDisk();
  return n;
}

function status() {
  return {
    kv: KV_ON,
    keys: mem.size,
    diskBytes: (() => { try { return fs.statSync(STORE_FILE).size; } catch { return 0; } })(),
  };
}

module.exports = { read, readSync, write, del, syncFromKV, status, DATA_DIR };
