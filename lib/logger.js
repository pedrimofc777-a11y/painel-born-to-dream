/**
 * logger.js — log simples com nível + arquivo rotativo
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(DATA_DIR, "logs.jsonl");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

let counter = 0;
function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
function emit(level, scope, msg, extra) {
  if (LEVELS[level] > LEVEL) return;
  const line = `${stamp()} [${level.toUpperCase()}] ${scope ? scope + " " : ""}${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: Date.now(), level, scope, msg, extra }) + "\n");
    // rotação simples: mantém no máximo ~4000 linhas
    const st = fs.statSync(LOG_FILE);
    if (st.size > 900000) {
      const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-2500).join("\n");
      fs.writeFileSync(LOG_FILE, lines);
    }
  } catch {}
}
const mk = (scope) => ({
  info: (m, e) => emit("info", scope, m, e),
  warn: (m, e) => emit("warn", scope, m, e),
  error: (m, e) => emit("error", scope, m, e),
  debug: (m, e) => emit("debug", scope, m, e),
});
function reqId() { counter = (counter + 1) % 100000; return Date.now().toString(36) + counter.toString(36); }

module.exports = { log: mk, mk, reqId, LOG_FILE };