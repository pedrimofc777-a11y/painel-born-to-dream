/**
 * backoff.js — espera exponencial com teto + jitter
 */
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function expo(attempt, base = 15000, cap = 300000) {
  const t = Math.min(base * Math.pow(2, attempt), cap);
  return Math.round(t + Math.random() * 3000); // jitter anti-thundering-herd
}

module.exports = { delay, expo };
