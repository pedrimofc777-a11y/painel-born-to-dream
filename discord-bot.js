// Bot do Discord: comandos + aviso de venda + aviso de IP de acesso.
// Roda no mesmo processo do painel.
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, Events } = require("discord.js");

const DATA = path.join(__dirname, "data");
const STATE = path.join(DATA, "bot.json");
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const save = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} };

const COMMANDS = [
  { name: "hoje", description: "Vendas de hoje" },
  { name: "ultima", description: "Última venda" },
  { name: "saldo", description: "Saldo disponível e pendente" },
  { name: "pendentes", description: "Próximas liberações" },
  { name: "ranking", description: "Top produtos (30 dias)" },
  { name: "membros", description: "Membros e dono" },
  { name: "previsao", description: "Previsão de robux a cair" },
  { name: "ticket", description: "Ticket médio (30 dias)" },
  { name: "compradores", description: "Top compradores (30 dias)" },
  { name: "resumo", description: "Resumo geral do grupo" },
  { name: "ajuda", description: "Lista de comandos" },
  { name: "ips", description: "Últimos acessos ao painel" },
  { name: "vendas", description: "Resumo do período", options: [{ name: "dias", description: "Dias (1-90)", type: 4, required: false, min_value: 1, max_value: 90 }] },
  { name: "produto", description: "Detalhe de um item", options: [{ name: "nome", description: "Digite para buscar", type: 3, required: true, autocomplete: true }] }
];

const fmtN = (n) => Number(n || 0).toLocaleString("pt-BR");

async function thumb(assetId) {
  try {
    if (!assetId) return null;
    const r = await fetch("https://thumbnails.roblox.com/v1/assets?assetIds=" + assetId + "&size=150x150&format=Png");
    const d = await r.json();
    return d.data && d.data[0] ? d.data[0].imageUrl : null;
  } catch { return null; }
}

function saleEmbed(t, todayCount, img) {
  const e = new EmbedBuilder().setColor(0xff7a00).setTitle("VENDA NOVA").setTimestamp(new Date(t.created))
    .setFooter({ text: "Born to Dream" });
  e.addFields(
    { name: "Item", value: t.assetId ? "[" + t.assetName + "](https://www.roblox.com/catalog/" + t.assetId + "/x)" : (t.assetName || "?"), inline: true },
    { name: "Comprador", value: t.buyerId ? "[" + t.buyerName + "](https://www.roblox.com/users/" + t.buyerId + "/profile)" : (t.buyerName || "?"), inline: true },
    { name: "Valor", value: String(t.robux), inline: true }
  );
  if (todayCount != null) e.addFields({ name: "Hoje", value: todayCount + " vendas", inline: true });
  if (img) e.setThumbnail(img);
  return e;
}

module.exports = function startBot(opts) {
  const port = opts.port;
  const token = opts.token;
  const channelId = opts.channelId;
  const guildId = opts.guildId;

  const say = (m) => console.log("[discord-bot] " + m);
  // o bot fala com a API local como qualquer cliente: manda o Bearer (PANEL_PASS).
  // o timeout evita o comando ficar preso em "pensando..." se o Roblox demorar.
  const api = async (p) => {
    const r = await fetch("http://127.0.0.1:" + port + p, {
      headers: { "x-bot": "1", authorization: "Bearer " + (opts.panelPass || process.env.PANEL_PASS || "") },
      signal: AbortSignal.timeout(30000),
    });
    return r.json();
  };

  let client = null;
  let tentativas = 0;
  let pollTimer = null;
  let watchdog = null;

  /* Client NOVO por tentativa: reutilizar um Client destruído
     faz o Discord identificar 2x e derrubar a sessão. */
  function novoClient() {
    const c = new Client({ intents: [GatewayIntentBits.Guilds] });

    c.once(Events.ClientReady, async () => {
      tentativas = 0; // conectou: zera o contador (senão o 1º reconnect já "desiste")
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      say("logado como " + c.user.tag + " - " + c.guilds.cache.size + " servidor(es)");
      try {
        const rest = new REST({ version: "10" }).setToken(token);
        if (guildId) {
          await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), { body: COMMANDS });
          say("comandos registrados no servidor (instantaneo)");
        } else {
          await rest.put(Routes.applicationCommands(c.user.id), { body: COMMANDS });
          say("comandos globais (demoram ate 1h)");
        }
      } catch (e) { say("comandos: " + e.message); }
      say("vigia de vendas ligado (1 min)");
      if (pollTimer) clearInterval(pollTimer);
      setTimeout(poll, 30000);
      pollTimer = setInterval(poll, 60000);
    });

    c.on(Events.Error, (e) => say("ERRO: " + e.message));
    c.on(Events.Warn, (e) => say("aviso: " + e.message));
    c.on(Events.ShardError, (e) => say("shard: " + e.message));
    c.on(Events.ShardDisconnect, (_e, code) => {
      const motivo = code === 4004 ? " (TOKEN INVALIDO)" : code === 4010 ? " (SHARD INVALIDO)" : code === 4014 ? " (INTENT NAO PERMITIDA)" : "";
      say("desconectou codigo " + code + motivo);
    });
    c.on(Events.ShardReconnecting, () => say("reconectando..."));
    c.on(Events.ShardResume, () => say("sessao retomada"));
    c.on(Events.Invalidated, () => say("sessao invalidada - token revogado, gere outro"));
    c.on(Events.InteractionCreate, (it) => tratarInteracao(it));
    return c;
  }

  /* Reconexão robusta:
     - NUNCA desiste (o bot reconecta sozinho pra sempre, com backoff).
     - O watchdog só dispara uma nova tentativa se ainda NÃO estiver pronto;
       ao conectar (ClientReady) ele é cancelado, então um READY lento não
       derruba mais um client que estava funcionando. */
  function entrar() {
    tentativas++;
    if (client) { try { client.destroy(); } catch {} }
    client = novoClient();
    say("tentativa " + tentativas + " - conectando...");
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (client && client.isReady && client.isReady()) return; // já logou; watchdog vira no-op
      const espera = Math.min(15000 + tentativas * 5000, 60000); // backoff suave
      say("ainda nao conectou em 20s - nova tentativa em " + Math.round(espera / 1000) + "s");
      entrar();
    }, 20000);
    if (watchdog.unref) watchdog.unref();
    client.login(token).then(
      () => say("token aceito, aguardando READY..."),
      (e) => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        say("LOGIN FALHOU: " + e.message + " - nova em 30s");
        setTimeout(entrar, 30000);
      }
    );
  }

  async function notifyAccess(info) {
    if (!channelId || !client) return;
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      const em = new EmbedBuilder().setColor(0x3ba55d).setTitle("ACESSO AO PAINEL").setTimestamp(new Date())
        .setFooter({ text: "Born to Dream" })
        .addFields(
          { name: "IP", value: "`" + info.ip + "`", inline: true },
          { name: "Pagina", value: "`" + info.page + "`", inline: true },
          { name: "Quando", value: info.when, inline: true },
          { name: "Dispositivo", value: (info.ua || "?").slice(0, 180) }
        );
      await ch.send({ embeds: [em] });
    } catch {}
  }
  global.__btdNotifyAccess = notifyAccess;

  async function poll() {
    try {
      if (!channelId || !client || !client.isReady()) return;
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      const a = await api("/api/analytics?days=1");
      if (!a || !a.transactions || !a.transactions.length) return;
      const st = load();
      // lista de ids ja vistos (migra do formato antigo "last")
      let seen = Array.isArray(st.seen) ? st.seen.map(String) : [];
      if (!seen.length && st.last) seen = [String(st.last)];
      const seenSet = new Set(seen);
      const isFirst = seenSet.size === 0;
      const now = Date.now();
      // na primeira leitura apos deploy, avisa vendas dos ultimos 15 min
      // (pega vendas que aconteceram durante o deploy); depois, avisa
      // tudo que ainda nao foi visto e tenha ate 3h (evita spam antigo)
      const maxAge = isFirst ? 15 * 60 * 1000 : 3 * 3600 * 1000;
      const fresh = a.transactions
        .filter((t) => !seenSet.has(String(t.id)))
        .filter((t) => {
          const ts = new Date(t.created).getTime();
          return !isNaN(ts) && now - ts >= 0 && now - ts < maxAge;
        })
        .reverse()
        .slice(-3);
      st.seen = a.transactions.slice(0, 100).map((t) => String(t.id));
      delete st.last;
      save(st);
      for (const t of fresh) {
        await ch.send({ content: "@everyone", embeds: [saleEmbed(t, a.todayCount, await thumb(t.assetId))] });
      }
      if (fresh.length) say(fresh.length + " venda(s) avisada(s)");
    } catch (e) { say("poll: " + e.message); }
  }

  async function tratarInteracao(it) {
    if (it.isAutocomplete()) {
      try {
        if (it.commandName === "produto") {
          const q = (it.options.getFocused() || "").toLowerCase();
          const a = await api("/api/analytics?days=30");
          const list = (a.ranking || []).filter((r) => (r.name || "").toLowerCase().includes(q)).slice(0, 24);
          await it.respond(list.map((r) => ({ name: String(r.name).slice(0, 100), value: String(r.assetId || r.name).slice(0, 100) })));
        } else { await it.respond([]); }
      } catch { try { await it.respond([]); } catch {} }
      return;
    }
    if (!it.isChatInputCommand()) return;
    try {
      await it.deferReply();
    } catch (de) { say("deferReply falhou: " + de.message); return; }
    const n = it.commandName;
    try {
      if (n === "hoje") {
        const a = await api("/api/analytics?days=1");
        await it.editReply("**Hoje:** " + (a.sales ?? 0) + " vendas - **" + fmtN(a.revenuePeriod) + "** (ticket " + (a.ticketMedio ?? 0) + ")");
      } else if (n === "ultima") {
        const a = await api("/api/analytics?days=1");
        const t = (a.transactions || [])[0];
        if (!t) return void it.editReply("Sem vendas ainda.");
        await it.editReply({ embeds: [saleEmbed(t, null, await thumb(t.assetId))] });
      } else if (n === "vendas") {
        const d = Math.min(Math.max(it.options.getInteger("dias") || 7, 1), 90);
        const a = await api("/api/analytics?days=" + d);
        await it.editReply("**" + d + "d:** " + (a.sales ?? 0) + " vendas - **" + fmtN(a.salesTotalRobux) + "** - ticket " + (a.ticketMedio ?? 0));
      } else if (n === "saldo") {
        const b = await api("/api/balance");
        const p = await api("/api/pending");
        const saida = p.proximo ? p.proximo.date + " (" + fmtN(p.proximo.robux) + (p.proximo.emDias != null ? ", em " + p.proximo.emDias + "d" : "") + ")" : "-";
        await it.editReply("**Disponivel:** " + (b.disponivel ?? "?") + " - **Pendente:** " + fmtN(p.pendingRobux ?? p.totalPending ?? "?") + "\n**Proximo a cair:** " + saida);
      } else if (n === "pendentes") {
        const p = await api("/api/pending");
        const lines = (p.porData || p.upcoming || []).slice(0, 7).map((u) => u.date + ": **" + fmtN(u.robux) + "**").join("\n") || "-";
        await it.editReply("**Liberacoes:**\n" + lines);
      } else if (n === "ranking") {
        const a = await api("/api/analytics?days=30");
        const lines = (a.ranking || []).slice(0, 5).map((r, i) => (i + 1) + ". " + r.name + " - " + r.vendas + "x (" + r.robux + ")").join("\n") || "-";
        await it.editReply("**Top 30d:**\n" + lines);
      } else if (n === "membros") {
        const g = await api("/api/group");
        await it.editReply("**" + (g.displayName || "") + ":** " + (g.memberCount ?? "?") + " membros - Dono: " + (g.owner ? g.owner.displayName + " (@" + g.owner.username + ")" : "?"));
      } else if (n === "previsao") {
        const p = await api("/api/pending");
        const em = new EmbedBuilder().setColor(0xff7a00).setTitle("PREVISAO DE ROBUX A CAIR")
          .setFooter({ text: "Born to Dream" })
          .setDescription("**Total pendente:** " + fmtN(p.totalPending ?? 0) + "\n**Proximo:** " + (p.proximo ? p.proximo.date + " - " + fmtN(p.proximo.robux) + (p.proximo.emDias != null ? " (em " + p.proximo.emDias + " dias)" : "") : "-"))
          .addFields({ name: "Por data de liberacao", value: (p.porData || []).slice(0, 10).map((u) => u.date + ": " + fmtN(u.robux)).join("\n") || "-" });
        await it.editReply({ embeds: [em] });
      } else if (n === "ticket") {
        const a = await api("/api/analytics?days=30");
        await it.editReply("**Ticket medio (30d):** " + (a.ticketMedio ?? "?") + " - " + (a.sales ?? "?") + " vendas");
      } else if (n === "compradores") {
        const a = await api("/api/analytics?days=30");
        const by = {};
        for (const t of (a.transactions || [])) {
          const nm = t.buyerName || "?";
          by[nm] = by[nm] || { name: nm, vendas: 0, robux: 0 };
          by[nm].vendas++; by[nm].robux += t.robux || 0;
        }
        const lines = Object.values(by).sort((x, y) => y.robux - x.robux).slice(0, 5).map((b, i) => (i + 1) + ". " + b.name + " - " + b.vendas + "x (" + b.robux + ")").join("\n") || "-";
        await it.editReply("**Top compradores:**\n" + lines);
      } else if (n === "resumo") {
        const a = await api("/api/analytics?days=7");
        const g = await api("/api/group");
        const b = await api("/api/balance");
        await it.editReply("**" + (g.displayName || "") + "** - " + (g.memberCount ?? "?") + " membros\n**7d:** " + (a.sales ?? "?") + " vendas - **" + fmtN(a.salesTotalRobux) + "**\n**Saldo:** " + (b.disponivel ?? "?") + " - **Pendente:** " + fmtN(b.pendente ?? "?"));
      } else if (n === "ajuda") {
        await it.editReply("**Comandos:** /hoje /ultima /vendas /saldo /pendentes /previsao /ticket /compradores /ranking /membros /produto /resumo /ips /ajuda");
      } else if (n === "ips") {
        const a = await api("/api/access-log");
        const em = new EmbedBuilder().setColor(0x3ba55d).setTitle("ULTIMOS ACESSOS AO PAINEL")
          .setFooter({ text: "Born to Dream" })
          .setDescription((a.items || []).slice(0, 8).map((i) => "`" + i.ip + "` - " + i.when + " - `" + i.page + "`").join("\n") || "Nenhum acesso registrado.");
        await it.editReply({ embeds: [em] });
      } else if (n === "produto") {
        const raw = it.options.getString("nome", true);
        const a = await api("/api/analytics?days=30");
        let hit = (a.ranking || []).find((r) => String(r.assetId) === raw);
        if (!hit) hit = (a.ranking || []).find((r) => (r.name || "").toLowerCase().includes(raw.toLowerCase()));
        if (!hit || !hit.assetId) return void it.editReply("Item nao encontrado nos ultimos 30 dias.");
        let d;
        try { d = await api("/api/product/" + hit.assetId + "/sales?days=30"); } catch { d = null; }
        if (!d || d.error) return void it.editReply("Roblox limitou a consulta. Tente de novo em 1 minuto.");
        const img = await thumb(hit.assetId);
        const em = new EmbedBuilder().setColor(0xff7a00).setTitle(d.name)
          .setFooter({ text: "Born to Dream" })
          .addFields(
            { name: "Vendas", value: String(d.vendas), inline: true },
            { name: "Total", value: String(d.robux), inline: true },
            { name: "Top comprador", value: (d.buyers || [])[0] ? d.buyers[0].name : "-", inline: true }
          );
        if (img) em.setThumbnail(img);
        await it.editReply({ embeds: [em] });
      }
    } catch (e) {
      say("handler: " + ((e && e.message) || e));
      try {
        if (it.deferred || it.replied) await it.editReply("Falha ao buscar. Tente de novo.");
        else await it.reply({ content: "Falha ao buscar. Tente de novo.", ephemeral: true });
      } catch {}
    }
  }

  say("iniciando login - token com " + String(token || "").length + " caracteres");
  if (String(token || "").split(".").length !== 3) {
    say("AVISO: token nao tem formato de bot (3 partes). Confira se nao copiou o Client Secret.");
  }
  entrar();
};
