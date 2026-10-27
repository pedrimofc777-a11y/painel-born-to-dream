/* Born to Dream — cache offline: abre o painel sem internet com os últimos dados */
const V = "btd-v7";
const CORE = [
  "/",
  "/index.html",
  "/login.html",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "https://cdn.jsdelivr.net/npm/chart.js",
  "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(V).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: "reload" }))))
      .catch(() => caches.open(V).then((c) => c.addAll(["/", "/styles.css", "/login.html"])))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // API: tenta rede, cai pro cache se estiver offline (mostra o último dado)
  if (url.pathname.startsWith("/api/")) {
    // /api/me e qualquer 401 NUNCA vão pro cache: senão o estado de login fica
    // "congelado" (servindo 200 velho) e o painel entra em loop de login.
    const ehAuth = url.pathname === "/api/me";
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (!ehAuth && r.status !== 401) {
            const copy = r.clone();
            caches.open(V).then((c) => c.put(req, copy)).catch(() => {});
          }
          return r;
        })
        .catch(async () => {
          if (ehAuth) {
            // estado de sessão não pode vir do cache — devolve 401 e deixa o app decidir
            return new Response(JSON.stringify({ error: "unauthorized", auth: true }), {
              status: 401, headers: { "Content-Type": "application/json" },
            });
          }
          const c = await caches.open(V);
          const hit = await c.match(req);
          if (hit) return hit;
          return new Response(JSON.stringify({ error: "offline", offline: true }), {
            status: 503, headers: { "Content-Type": "application/json" },
          });
        })
    );
    return;
  }

  // navegação: rede primeiro, cache se offline
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(async () => {
        const c = await caches.open(V);
        return (await c.match("/index.html")) || (await c.match("/")) || Response.error();
      })
    );
    return;
  }

  // estáticos: cache primeiro, atualiza em segundo plano
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(V).then((c) => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
