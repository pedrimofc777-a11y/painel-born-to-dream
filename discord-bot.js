// Bot do Discord: comandos + aviso de venda + aviso de IP de acesso.
// Roda no mesmo processo do painel.
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, Events } = require("discord.js");

const DATA = path.join(__dirname, "data");
const STATE = path.join(DATA, "bot.json");
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const save = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} };

const SP = "America/Sao_Paulo";

const COMMANDS = [
  { name: "hoje", description: "Vendas de hoje" },
  { name: "ultima", description: "Última venda registrada" },
  { name: "vendas", description: "Resumo de vendas de um período", options: [{ name: "dias", description: "Dias (1-90)", type: 4, required: false, min_value: 1, max_value: 90 }] },
  { name: "saldo", description: "Saldo disponível e pendente" },
  { name: "pendentes", description: "Próximas liberações de robux" },
  { name: "previsao", description: "Previsão de robux a cair" },
  { name: "ranking", description: "Top produtos do período" },
  { name: "compradores", description: "Quem mais comprou" },
  { name: "ticket", description: "Ticket médio" },
  { name: "meta", description: "Progresso das metas do painel" },
  { name: "evolucao", description: "Vendas dia a dia (gráfico)" },
  { name: "horario", description: "Melhores horários de venda" },
  { name: "resumo", description: "Resumo geral do grupo" },
  { name: "status", description: "Saúde dos dados do painel" },
  { name: "relatorio", description: "Relatório completo de um dia", options: [{ name: "data", description: "Data no formato AAAA-MM-DD", type: 3, required: false }] },
  { name: "membros", description: "Membros e dono do grupo" },
  { name: "produto", description: "Detalhe de um item", options: [{ name: "nome", description: "Digite para buscar", type: 3, required: true, autocomplete: true }] },
  { name: "ips", description: "IPs distintos que acessaram o painel" },
  { name: "ajuda", description: "Lista de comandos" },
];

/* ═══════════ visual: todo comando sai num embed padronizado ═══════════ */
const C = { vendas: 0xff7a00, acesso: 0x3ba55d, info: 0x5865f2, alerta: 0xf1c40f, erro: 0xe74c3c, meta: 0x9b59b6 };
const fmtN = (n) => Number(n || 0).toLocaleString("pt-BR");
const fmtR = (n) => "R$ " + fmtN(Math.round(Number(n || 0) * 100) / 100);
const horaSP = (d) => new Date(d == null ? Date.now() : d).toLocaleTimeString("pt-BR", { timeZone: SP, hour: "2-digit", minute: "2-digit" });
const emb = (cor, titulo, desc) => {
  const e = new EmbedBuilder().setColor(cor).setTitle(titulo).setFooter({ text: "Born to Dream • " + horaSP() });
  if (desc) e.setDescription(String(desc).slice(0, 3900));
  return e;
};
const sincronizando = () => emb(C.alerta, "⏳  Sincronizando…", "O Roblox ainda está entregando os dados.\nTente de novo em **30 segundos**.");
const falha = () => emb(C.erro, "😵  Não consegui buscar", "O Roblox limitou a consulta. Tente de novo em **1 minuto**.");
function barra(p, n = 10) {
  const f = Math.max(0, Math.min(n, Math.round((Number(p) || 0) * n)));
  return "▰".repeat(f) + "▱".repeat(n - f);
}
const seta = (v) => (v > 0 ? "🔺" : v < 0 ? "🔻" : "➖");
function diaSP(ts) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: SP, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts)); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}
function horaSPnum(ts) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: SP, hour: "numeric", hour12: false }).formatToParts(new Date(ts));
    return parseInt((p.find((x) => x.type === "hour") || {}).value || "0", 10) || 0;
  } catch { return 0; }
}
const brl = (key) => `${String(key).slice(8, 10)}/${String(key).slice(5, 7)}`;

async function thumb(assetId) {
  try {
    if (!assetId) return null;
    const r = await fetch("https://thumbnails.roblox.com/v1/assets?assetIds=" + assetId + "&size=150x150&format=Png");
    const d = await r.json();
    return d.data && d.data[0] ? d.data[0].imageUrl : null;
  } catch { return null; }
}

function saleEmbed(t, todayCount, img) {
  const e = emb(C.vendas, "💰  VENDA NOVA").setTimestamp(new Date(t.created));
  e.addFields(
    { name: "Item", value: t.assetId ? "[" + (t.assetName || "?") + "](https://www.roblox.com/catalog/" + t.assetId + "/x)" : (t.assetName || "?"), inline: true },
    { name: "Comprador", value: t.buyerId ? "[" + (t.buyerName || "?") + "](https://www.roblox.com/users/" + t.buyerId + "/profile)" : (t.buyerName || "?"), inline: true },
    { name: "Valor", value: fmtR(t.robux), inline: true },
    { name: "Horário", value: horaSP(new Date(t.created)) + " (SP)", inline: true }
  );
  if (todayCount != null) e.addFields({ name: "Vendas hoje", value: fmtN(todayCount) + " vendas", inline: true });
  if (img) e.setThumbnail(img);
  return e;
}

/* localização estimada do IP (o servidor já devolve `geo` pronto) */
function ondeTexto(g) {
  if (!g) return "localização indisponível";
  const local = g.city && g.region && g.city !== g.region ? g.city + ", " + g.region : (g.city || g.region);
  if (!local) return "localização indisponível";
  const fora = g.cc && g.cc !== "BR" && g.country ? " • " + g.country : "";
  return "Aproximadamente " + local + fora;
}

/* relatório do dia — usado no /relatorio e no aviso automático das 00h */
function relatorioEmbed(d) {
  const e = emb(C.vendas, "📊  RELATÓRIO DIÁRIO — " + brl(d.date));
  e.setDescription(
    `**${fmtN(d.sales)} vendas** • **${fmtR(d.robux)}** • ticket **${fmtR(d.ticket)}**\n` +
    `**${fmtN(d.compradores)}** comprador(es) • **${fmtN(d.distintos)}** item(ns) distintos`
  );
  const dv = (d.sales || 0) - (d.prevSales || 0);
  const dr = (d.robux || 0) - (d.prevRobux || 0);
  e.addFields(
    { name: "Dia anterior (" + brl(d.prevDate) + ")", value: `${fmtN(d.prevSales)} vendas • ${fmtR(d.prevRobux)}\n${seta(dv)} ${dv >= 0 ? "+" : ""}${fmtN(dv)} vendas\n${seta(dr)} ${dr >= 0 ? "+" : ""}${fmtN(dr)} R$`, inline: true },
    { name: "🕐 Melhor horário", value: d.melhorHora >= 0 ? String(d.melhorHora).padStart(2, "0") + "h" : "—", inline: true }
  );
  if (d.top && d.top.length) {
    e.addFields({
      name: "🏆  Top do dia",
      value: d.top.slice(0, 3).map((t, i) => `${i + 1}. **${t.name}** — ${fmtN(t.vendas)}x (${fmtR(t.robux)})`).join("\n").slice(0, 1000),
    });
  }
  if (d.parcial) e.addFields({ name: "⚠️  Aviso", value: "Leitura parcial (Roblox limitando) — pode faltar vendas do fim do dia.", inline: false });
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
  const api = async (p, timeout = 30000) => {
    const r = await fetch("http://127.0.0.1:" + port + p, {
      headers: { "x-bot": "1", authorization: "Bearer " + (opts.panelPass || process.env.PANEL_PASS || "") },
      signal: AbortSignal.timeout(timeout),
    });
    return r.json();
  };

  let client = null;
  let tentativas = 0;
  let pollTimer = null;
  let watchdog = null;
  let repTimer = null;

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
      // relatório automático do dia às 00h (São Paulo)
      agendarRelatorio();
      try {
        const st = load();
        const ontem = diaSP(Date.now() - 86400000);
        if (horaSPnum(Date.now()) < 1 && st.repDia !== ontem) {
          say("recuperando relatorio das 00h de " + ontem);
          setTimeout(() => mandarRelatorioDiario(ontem).catch(() => {}), 8000);
        }
      } catch {}
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
      const em = emb(C.acesso, "🔐  ACESSO AO PAINEL")
        .setTimestamp(new Date())
        .addFields(
          { name: "IP", value: "`" + info.ip + "`", inline: true },
          { name: "Onde (estimado)", value: ondeTexto(info.geo), inline: true },
          { name: "Quando", value: info.when, inline: true },
          { name: "Página", value: "`" + info.page + "`", inline: true },
          { name: "Dispositivo", value: (info.ua || "?").slice(0, 300) }
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
      /* o Roblox devolve id 0 em TODAS as transações de grupo: a lista antiga
         ficava ["0","0",...] e travava o aviso pra SEMPRE. Se for esse caso, zera. */
      if (seen.length && seen.every((s) => s === "0" || s === "null" || s === "undefined")) seen = [];
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

  /* ═══════════ relatório do dia (automático às 00h) ═══════════ */
  async function montarRelatorio(dateKey, tentativas) {
    for (let i = 0; i < tentativas; i++) {
      try {
        // timeout longo: o servidor faz uma busca NOVA de 25 páginas e espera
        const d = await api("/api/daily-report?date=" + encodeURIComponent(dateKey), 300000);
        if (d && !d.error && typeof d.sales === "number") return relatorioEmbed(d);
        say("relatorio tentativa " + (i + 1) + ": sem dados");
      } catch (e) {
        say("relatorio tentativa " + (i + 1) + ": " + ((e && e.message) || e));
      }
      if (i < tentativas - 1) await new Promise((r) => setTimeout(r, 60000));
    }
    return null;
  }

  async function mandarRelatorioDiario(dateKey) {
    if (!channelId || !client || !client.isReady()) return;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const em = await montarRelatorio(dateKey, 3);
    if (!em) { say("relatorio de " + dateKey + " nao foi possivel gerar"); return; }
    await ch.send({ embeds: [em] });
    const st = load(); st.repDia = dateKey; save(st);
    say("relatorio de " + dateKey + " enviado");
  }

  function agendarRelatorio() {
    if (repTimer) clearTimeout(repTimer);
    const spMs = Date.now() - 3 * 3600 * 1000; // agora em horario de Sao Paulo (UTC-3)
    const d = new Date(spMs);
    const prox = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const espera = Math.max(3000, prox - spMs + 20000); // 00h00m20 de SP
    repTimer = setTimeout(() => {
      try {
        const alvo = diaSP(Date.now() - 86400000);
        say("relatorio das 00h: " + alvo);
        mandarRelatorioDiario(alvo).catch((e) => say("relatorio: " + ((e && e.message) || e)));
      } catch (e) { say("relatorio: " + ((e && e.message) || e)); }
      agendarRelatorio();
    }, espera);
    if (repTimer.unref) repTimer.unref();
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
        if (a.partial || a.sales == null) return void await it.editReply({ embeds: [sincronizando()] });
        const t = (a.transactions || [])[0];
        const e = emb(C.vendas, "🛒  VENDAS DE HOJE",
          `**${fmtN(a.todayCount)} vendas** • **${fmtR(a.revenueToday)}**`);
        e.addFields({ name: "Ticket médio", value: a.ticketMedio ? fmtR(a.ticketMedio) : "—", inline: true });
        if (t) e.addFields({ name: "Última venda", value: `${t.assetName || "?"} — ${fmtR(t.robux)}\n${horaSP(new Date(t.created))} (SP)`, inline: false });
        await it.editReply({ embeds: [e] });

      } else if (n === "ultima") {
        const a = await api("/api/analytics?days=1");
        const t = (a.transactions || [])[0];
        if (!t) return void await it.editReply({ embeds: [emb(C.vendas, "💸  Sem vendas", "Ainda não há nenhuma venda registrada.")] });
        await it.editReply({ embeds: [saleEmbed(t, a.todayCount, await thumb(t.assetId))] });

      } else if (n === "vendas") {
        const d = Math.min(Math.max(it.options.getInteger("dias") || 7, 1), 90);
        const a = await api("/api/analytics?days=" + d);
        if (a.partial || a.sales == null) return void await it.editReply({ embeds: [sincronizando()] });
        const e = emb(C.vendas, `📈  VENDAS — ${d} DIA${d > 1 ? "S" : ""}`,
          `**${fmtN(a.sales)} vendas** • **${fmtR(a.salesTotalRobux)}**`);
        e.addFields(
          { name: "Ticket médio", value: a.ticketMedio ? fmtR(a.ticketMedio) : "—", inline: true },
          { name: "Por dia", value: (a.sales ? Math.round((a.sales / a.days) * 10) / 10 : 0) + " vendas", inline: true },
          { name: "Robux por dia", value: fmtR(a.days ? a.salesTotalRobux / a.days : 0), inline: true }
        );
        await it.editReply({ embeds: [e] });

      } else if (n === "saldo") {
        const [b, p] = [await api("/api/balance"), await api("/api/pending")];
        const prox = p.proximo ? `${brl(p.proximo.date)} • ${fmtR(p.proximo.robux)}${p.proximo.emDias != null ? ` (em ${p.proximo.emDias}d)` : ""}` : "—";
        const e = emb(C.info, "🏦  SALDO DO GRUPO")
          .addFields(
            { name: "💰 Disponível", value: b.disponivel != null ? fmtN(b.disponivel) : "—", inline: true },
            { name: "⏳ Pendente", value: fmtR(p.pendingRobux ?? p.totalPending ?? 0), inline: true },
            { name: "📥 Próximo a cair", value: prox, inline: false }
          );
        await it.editReply({ embeds: [e] });

      } else if (n === "pendentes") {
        const p = await api("/api/pending");
        const lista = (p.porData || p.upcoming || []).slice(0, 8);
        const e = emb(C.alerta, "⏳  PRÓXIMAS LIBERAÇÕES",
          `**Total pendente:** ${fmtR(p.pendingRobux ?? p.totalPending ?? 0)}`);
        if (lista.length) {
          e.addFields({
            name: "Por data",
            value: lista.map((u) => `**${brl(u.date)}** — ${fmtR(u.robux)}${u.emDias != null ? ` • ${u.emDias}d` : ""}`).join("\n").slice(0, 1000),
          });
        } else e.setDescription(`**Total pendente:** ${fmtR(p.pendingRobux ?? p.totalPending ?? 0)}\nSem liberações agendadas no momento.`);
        await it.editReply({ embeds: [e] });

      } else if (n === "ranking") {
        const a = await api("/api/analytics?days=30");
        if (!a.ranking || !a.ranking.length) return void await it.editReply({ embeds: [emb(C.vendas, "🏆  Ranking", "Sem vendas no período.")] });
        const e = emb(C.vendas, "🏆  TOP PRODUTOS — 30 DIAS",
          a.ranking.slice(0, 8).map((r, i) => `${["🥇","🥈","🥉"][i] || (i + 1) + "."} **${r.name}**\n     ${fmtN(r.vendas)} vendas • ${fmtR(r.robux)}`).join("\n"));
        await it.editReply({ embeds: [e] });

      } else if (n === "compradores") {
        const a = await api("/api/analytics?days=30");
        const by = {};
        for (const t of (a.transactions || [])) {
          const nm = t.buyerName || "?";
          by[nm] = by[nm] || { name: nm, id: t.buyerId, vendas: 0, robux: 0 };
          by[nm].vendas++; by[nm].robux += t.robux || 0;
        }
        const top = Object.values(by).sort((x, y) => y.robux - x.robux).slice(0, 8);
        if (!top.length) return void await it.editReply({ embeds: [emb(C.vendas, "🛒  Compradores", "Sem compradores ainda.")] });
        const e = emb(C.vendas, "🛒  TOP COMPRADORES — 30 DIAS",
          top.map((b, i) => `${["🥇","🥈","🥉"][i] || (i + 1) + "."} ${b.id ? `[${b.name}](https://www.roblox.com/users/${b.id}/profile)` : b.name} — ${b.vendas}x • ${fmtR(b.robux)}`).join("\n"));
        await it.editReply({ embeds: [e] });

      } else if (n === "ticket") {
        const a = await api("/api/analytics?days=30");
        if (a.partial || a.sales == null) return void await it.editReply({ embeds: [sincronizando()] });
        const e = emb(C.vendas, "🎯  TICKET MÉDIO — 30 DIAS",
          `**${fmtR(a.ticketMedio)}** por venda`)
          .addFields(
            { name: "Vendas", value: fmtN(a.sales), inline: true },
            { name: "Total", value: fmtR(a.salesTotalRobux), inline: true },
            { name: "Por dia", value: fmtR(a.days ? a.salesTotalRobux / a.days : 0), inline: true }
          );
        await it.editReply({ embeds: [e] });

      } else if (n === "meta") {
        const g = await api("/api/goals");
        const periodo = Math.min(Math.max(Number(g.period) || 30, 1), 90);
        const a = await api("/api/analytics?days=" + periodo);
        const metas = (g.goals || []);
        if (!metas.length) return void await it.editReply({ embeds: [emb(C.meta, "🎯  Metas", "Nenhuma meta definida no painel ainda.")] });
        if (a.partial || a.sales == null) return void await it.editReply({ embeds: [sincronizando()] });
        const atual = a.salesTotalRobux || 0;
        const e = emb(C.meta, `🎯  METAS — ${periodo} DIAS`);
        const linhas = metas.slice(0, 12).map((m) => {
          const pct = m > 0 ? atual / m : 0;
          const batida = atual >= m;
          return `${batida ? "✅" : "▫️"} **${fmtR(m)}** ${barra(pct)} ${Math.min(100, Math.round(pct * 100))}%`;
        }).join("\n");
        e.setDescription(`Atual: **${fmtR(atual)}** em **${fmtN(a.sales)} vendas**\n\n${linhas}`);
        const falta = metas.find((m) => atual < m);
        if (falta) e.addFields({ name: "Próxima meta", value: `Faltam **${fmtR(falta - atual)}**`, inline: true });
        await it.editReply({ embeds: [e] });

      } else if (n === "evolucao") {
        const a = await api("/api/analytics?days=14");
        const dias = a.byDay || [];
        if (!dias.length) return void await it.editReply({ embeds: [sincronizando()] });
        const max = Math.max(...dias.map((x) => x.robux || 0), 1);
        const e = emb(C.vendas, "📉  EVOLUÇÃO — 14 DIAS",
          dias.map((x) => `**${x.weekday}** \`${x.label}\` ${x.robux ? "▓".repeat(Math.max(1, Math.round((x.robux / max) * 14))) : "·"} ${fmtR(x.robux)}`).join("\n"));
        const total = dias.reduce((s, x) => s + (x.robux || 0), 0);
        e.addFields({ name: "Total do período", value: fmtR(total) + " • média " + fmtR(total / dias.length), inline: true });
        await it.editReply({ embeds: [e] });

      } else if (n === "horario") {
        const a = await api("/api/analytics?days=30");
        const txs = a.salesList || a.transactions || [];
        if (!txs.length) return void await it.editReply({ embeds: [sincronizando()] });
        const horas = Array.from({ length: 24 }, () => ({ n: 0, r: 0 }));
        const fmtH = new Intl.DateTimeFormat("en-US", { timeZone: SP, hour: "numeric", hour12: false });
        for (const t of txs) {
          const p = fmtH.formatToParts(new Date(t.created));
          const h = (parseInt((p.find((x) => x.type === "hour") || {}).value || "0", 10) || 0) % 24;
          horas[h].n++; horas[h].r += t.robux || 0;
        }
        const comDados = horas.map((h, i) => ({ i, n: h.n, r: h.r })).filter((h) => h.n > 0);
        if (!comDados.length) return void await it.editReply({ embeds: [emb(C.vendas, "🕐  Horários", "Sem vendas no período.")] });
        const max = Math.max(...comDados.map((h) => h.r), 1);
        const melhor = comDados.slice().sort((x, y) => y.r - x.r)[0];
        const e = emb(C.vendas, "🕐  MELHORES HORÁRIOS — 30 DIAS (horário de SP)",
          comDados.map((h) => `\`${String(h.i).padStart(2, "0")}h\` ${h.r ? "▓".repeat(Math.max(1, Math.round((h.r / max) * 14))) : "·"} ${fmtN(h.n)}x • ${fmtR(h.r)}`).join("\n"));
        e.addFields({ name: "🏆 Pico", value: `${String(melhor.i).padStart(2, "0")}h — ${fmtN(melhor.n)} vendas • ${fmtR(melhor.r)}`, inline: true });
        await it.editReply({ embeds: [e] });

      } else if (n === "status") {
        const a = await api("/api/analytics?days=1");
        let p = null, b = null;
        try { p = await api("/api/pending"); } catch {}
        try { b = await api("/api/balance"); } catch {}
        const salvo = a.savedAt ? new Date(a.savedAt) : null;
        const min = salvo ? Math.max(0, Math.round((Date.now() - salvo) / 60000)) : null;
        const estado = a.txError ? `⚠️ erro ${a.txError}` : a.partial ? "⚠️ parcial — Roblox limitando" : a.stale ? "🟡 cache antigo, atualizando" : "✅ fresco";
        const e = emb(C.info, "🩺  SAÚDÉ DOS DADOS", `**Estado:** ${estado}`);
        e.addFields(
          { name: "Última leitura", value: salvo ? `${horaSP(salvo)} (SP) • há ${min} min` : "—", inline: true },
          { name: "Vendas hoje", value: `${fmtN(a.todayCount)} • ${fmtR(a.revenueToday)}`, inline: true },
          { name: "Pendente", value: p ? fmtR(p.pendingRobux ?? p.totalPending) : "—", inline: true },
          { name: "Disponível", value: b && b.disponivel != null ? fmtN(b.disponivel) : "—", inline: true },
          { name: "Aviso", value: min != null && min > 3 ? "Dados com mais de 3 min — o Roblox pode estar limitando." : "Atualizando normalmente.", inline: false }
        );
        await it.editReply({ embeds: [e] });

      } else if (n === "relatorio") {
        const pedida = (it.options.getString("data") || "").trim();
        const dateKey = pedida || diaSP(Date.now() - 86400000);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
          return void await it.editReply({ embeds: [emb(C.erro, "🗓  Data inválida", "Use o formato **AAAA-MM-DD**, ex.: `2026-11-02`.")] });
        }
        const em = await montarRelatorio(dateKey, 1);
        await it.editReply({ embeds: [em || falha()] });

      } else if (n === "membros") {
        const g = await api("/api/group");
        const e = emb(C.info, "👥  GRUPO", `**${g.displayName || "—"}**`)
          .addFields(
            { name: "Membros", value: fmtN(g.memberCount), inline: true },
            { name: "Dono", value: g.owner ? `${g.owner.displayName} (@${g.owner.username})` : "—", inline: true },
            { name: "ID", value: String(g.id || "—"), inline: true }
          );
        await it.editReply({ embeds: [e] });

      } else if (n === "previsao") {
        const p = await api("/api/pending");
        const e = emb(C.alerta, "🔮  PREVISÃO DE ROBUX A CAIR",
          `**Total pendente:** ${fmtR(p.totalPending ?? p.pendingRobux ?? 0)}\n` +
          `**Próximo:** ${p.proximo ? `${brl(p.proximo.date)} — ${fmtR(p.proximo.robux)}${p.proximo.emDias != null ? ` (em ${p.proximo.emDias} dias)` : ""}` : "—"}`);
        const lista = (p.porData || []).slice(0, 10);
        if (lista.length) {
          e.addFields({
            name: "📅 Por data de liberação",
            value: lista.map((u) => `**${brl(u.date)}** — ${fmtR(u.robux)}`).join("\n").slice(0, 1000),
          });
        }
        await it.editReply({ embeds: [e] });

      } else if (n === "resumo") {
        const [a, g, b, p] = [await api("/api/analytics?days=7"), await api("/api/group"), await api("/api/balance"), await api("/api/pending")];
        const e = emb(C.vendas, `📋  RESUMO — ${g.displayName || "Grupo"}`);
        e.setDescription(`**7 dias:** ${fmtN(a.sales)} vendas • ${fmtR(a.salesTotalRobux)}\n**Hoje:** ${fmtN(a.todayCount)} vendas • ${fmtR(a.revenueToday)}`);
        e.addFields(
          { name: "👥 Membros", value: fmtN(g.memberCount), inline: true },
          { name: "💰 Disponível", value: b.disponivel != null ? fmtN(b.disponivel) : "—", inline: true },
          { name: "⏳ Pendente", value: fmtR(p.pendingRobux ?? p.totalPending ?? 0), inline: true },
          { name: "🎯 Ticket 7d", value: a.ticketMedio ? fmtR(a.ticketMedio) : "—", inline: true }
        );
        await it.editReply({ embeds: [e] });

      } else if (n === "ajuda") {
        const e = emb(C.info, "📖  COMANDOS DO BOT", [
          "**🛒 Vendas**",
          "`/hoje` vendas de hoje • `/ultima` última venda • `/vendas 30` período • `/ticket` ticket médio",
          "`/ranking` top produtos • `/compradores` quem mais comprou • `/produto` detalhe de um item",
          "",
          "**💵 Dinheiro**",
          "`/saldo` disponível e pendente • `/pendentes` próximas liberações • `/previsao` robux a cair",
          "`/meta` progresso das metas do painel",
          "",
          "**📊 Análise**",
          "`/evolucao` vendas dia a dia • `/horario` melhores horários • `/relatorio` relatório de um dia",
          "`/status` saúde dos dados • `/resumo` resumo geral do grupo",
          "",
          "**🌐 Painel**",
          "`/ips` IPs distintos que entraram • `/membros` membros e dono • `/ajuda` esta lista",
        ].join("\n"));
        await it.editReply({ embeds: [e] });

      } else if (n === "ips") {
        const a = await api("/api/access-log", 60000);
        const uniq = a.unique || [];
        if (!uniq.length) {
          return void await it.editReply({ embeds: [emb(C.acesso, "🌐  ACESSOS AO PAINEL", "Nenhum acesso registrado ainda.")] });
        }
        const total = uniq.reduce((s, u) => s + (u.count || 0), 0);
        const linhas = uniq.slice(0, 20).map((u) => `\`${u.ip}\` — ${ondeTexto(u.geo)} (${u.count}x)`);
        const e = emb(C.acesso, "🌐  IPs QUE ACESSARAM O PAINEL",
          `**${uniq.length} IP(s) distinto(s)** • ${fmtN(total)} acesso(s)\n\n${linhas.join("\n")}`);
        const primeiro = uniq[0];
        if (primeiro && primeiro.when) e.addFields({ name: "Último acesso", value: `${primeiro.when} • \`${primeiro.ip}\``, inline: true });
        await it.editReply({ embeds: [e] });

      } else if (n === "produto") {
        const raw = it.options.getString("nome", true);
        const a = await api("/api/analytics?days=30");
        let hit = (a.ranking || []).find((r) => String(r.assetId) === raw);
        if (!hit) hit = (a.ranking || []).find((r) => (r.name || "").toLowerCase().includes(raw.toLowerCase()));
        if (!hit || !hit.assetId) return void await it.editReply({ embeds: [emb(C.erro, "🔍  Item não encontrado", "Não achei esse item nas vendas dos últimos 30 dias.")] });
        let d;
        try { d = await api("/api/product/" + hit.assetId + "/sales?days=30", 60000); } catch { d = null; }
        if (!d || d.error) return void await it.editReply({ embeds: [falha()] });
        const img = await thumb(hit.assetId);
        const e = emb(C.vendas, "📦  " + (d.name || hit.name))
          .addFields(
            { name: "Vendas", value: fmtN(d.vendas), inline: true },
            { name: "Total", value: fmtR(d.robux), inline: true },
            { name: "Ticket", value: d.vendas ? fmtR(d.robux / d.vendas) : "—", inline: true },
            { name: "Top comprador", value: (d.buyers || [])[0] ? d.buyers[0].name : "—", inline: true }
          );
        const dias = (d.byDay || []).slice(-7);
        if (dias.length) {
          const max = Math.max(...dias.map((x) => x.robux || 0), 1);
          e.addFields({
            name: "📉 Últimos dias",
            value: dias.map((x) => `\`${x.date.slice(8, 10)}/${x.date.slice(5, 7)}\` ${x.robux ? "▓".repeat(Math.max(1, Math.round((x.robux / max) * 8))) : "·"} ${fmtR(x.robux)}`).join("\n").slice(0, 1000),
          });
        }
        if (img) e.setThumbnail(img);
        await it.editReply({ embeds: [e] });
      }
    } catch (e) {
      say("handler: " + ((e && e.message) || e));
      try {
        if (it.deferred || it.replied) await it.editReply({ embeds: [falha()] });
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
