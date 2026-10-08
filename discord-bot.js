// Bot do Discord: comandos + aviso de venda. Roda no mesmo processo do painel.
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require("discord.js");

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
  { name: "previsao", description: "Próximas liberações" },
  { name: "ticket", description: "Ticket médio (30 dias)" },
  { name: "compradores", description: "Top compradores (30 dias)" },
  { name: "resumo", description: "Resumo geral do grupo" },
  { name: "ajuda", description: "Lista de comandos" },
  {
    name: "vendas", description: "Resumo do período",
    options: [{ name: "dias", description: "Dias (1-90)", type: 4, required: false, min_value: 1, max_value: 90 }],
  },
  {
    name: "produto", description: "Detalhe de um item",
    options: [{ name: "nome", description: "Digite para buscar", type: 3, required: true, autocomplete: true }],
  },
];

async function thumb(assetId) {
  try {
    if (!assetId) return null;
    const r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=150x150&format=Png`);
    const d = await r.json();
    return d.data && d.data[0] ? d.data[0].imageUrl : null;
  } catch { return null; }
}

function saleEmbed(t, todayCount, img) {
  const e = new EmbedBuilder().setColor(0xff7a00).setTitle("🆕 VENDA NOVA").setTimestamp(new Date(t.created))
    .setFooter({ text: "Born to Dream • Roblox Analytics" });
  e.addFields(
    { name: "📦 Item", value: t.assetId ? `[${t.assetName}](https://www.roblox.com/catalog/${t.assetId}/x)` : (t.assetName || "?"), inline: true },
    { name: "🙋 Comprador", value: t.buyerId ? `[${t.buyerName}](https://www.roblox.com/users/${t.buyerId}/profile)` : (t.buyerName || "?"), inline: true },
    { name: "💰 Valor", value: `${t.robux}`, inline: true },
  );
  if (todayCount != null) e.addFields({ name: "📊 Hoje", value: `${todayCount} vendas`, inline: true });
  if (img) e.setThumbnail(img);
  return e;
}

module.exports = function startBot({ port, token, channelId, guildId }) {
  const api = async (p) => {
    const r = await fetch(`http://localhost:${port}${p}`);
    return r.json();
  };
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", async () => {
    console.log(`[discord-bot] logado como ${client.user.tag}`);
    try {
      const rest = new REST({ version: "10" }).setToken(token);
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: COMMANDS });
      } else {
        await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
        console.log("[discord-bot] comandos globais (podem demorar até 1h)");
      }
    } catch (e) { console.log("[discord-bot] comandos:", e.message); }
    setInterval(poll, 60 * 1000);
    poll();
  });

  async function poll() {
    try {
      if (!channelId) return;
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      const a = await api("/api/analytics?days=1");
      if (!a.transactions || !a.transactions.length) return;
      const st = load();
      if (!st.last) { st.last = String(a.transactions[0].id); save(st); return; } // 1ª leitura: só marca
      const fresh = a.transactions.filter((t) => Number(t.id) > Number(st.last)).reverse().slice(-3);
      st.last = String(a.transactions[0].id);
      save(st);
      for (const t of fresh) {
        await ch.send({ embeds: [saleEmbed(t, a.todayCount, await thumb(t.assetId))] });
      }
      if (fresh.length) console.log(`[discord-bot] ${fresh.length} venda(s) avisada(s)`);
    } catch (e) { console.log("[discord-bot] poll:", e.message); }
  }

  client.on("interactionCreate", async (it) => {
    if (it.isAutocomplete()) {
      try {
        if (it.commandName === "produto") {
          const q = (it.options.getFocused() || "").toLowerCase();
          const a = await api("/api/analytics?days=30");
          const list = (a.ranking || []).filter((r) => (r.name || "").toLowerCase().includes(q)).slice(0, 25);
          await it.respond(list.map((r) => ({ name: String(r.name).slice(0, 100), value: String(r.assetId || r.name).slice(0, 100) })));
        } else { await it.respond([]); }
      } catch { try { await it.respond([]); } catch {} }
      return;
    }
    if (!it.isChatInputCommand()) return;
    try {
      await it.deferReply();
      const n = it.commandName;
      if (n === "hoje") {
        const a = await api("/api/analytics?days=1");
        await it.editReply(`**Hoje:** ${a.sales ?? 0} vendas • **${a.revenuePeriod ?? 0}** (ticket ${a.ticketMedio ?? 0})`);
      } else if (n === "ultima") {
        const a = await api("/api/analytics?days=1");
        const t = (a.transactions || [])[0];
        if (!t) return void it.editReply("Sem vendas ainda.");
        await it.editReply({ embeds: [saleEmbed(t, null, await thumb(t.assetId))] });
      } else if (n === "vendas") {
        const d = Math.min(Math.max(it.options.getInteger("dias") || 7, 1), 90);
        const a = await api(`/api/analytics?days=${d}`);
        await it.editReply(`**${d}d:** ${a.sales ?? 0} vendas • **${a.salesTotalRobux ?? 0}** • ticket ${a.ticketMedio ?? 0}`);
      } else if (n === "saldo") {
        const b = await api("/api/balance");
        const p = await api("/api/pending");
        await it.editReply(`**Disponível:** ${b.disponivel ?? "?"} • **Pendente:** ${b.pendente ?? "?"} • Cai em: ${p.oldestDate || "?"} (${p.oldestRobux ?? "?"})`);
      } else if (n === "pendentes") {
        const p = await api("/api/pending");
        const lines = (p.upcoming || []).slice(0, 7).map((u) => `${u.date}: **${u.robux}**`).join("\n") || "—";
        await it.editReply(`**Liberações:**\n${lines}`);
      } else if (n === "ranking") {
        const a = await api("/api/analytics?days=30");
        const lines = (a.ranking || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.name} — ${r.vendas}x (${r.robux})`).join("\n") || "—";
        await it.editReply(`**Top 30d:**\n${lines}`);
      } else if (n === "membros") {
        const g = await api("/api/group");
        await it.editReply(`**${g.displayName || ""}:** ${g.memberCount ?? "?"} membros • Dono: ${g.owner ? `${g.owner.displayName} (@${g.owner.username})` : "?"}`);
      } else if (n === "previsao") {
        const p = await api("/api/pending");
        const tot = (p.upcoming || []).reduce((s, u) => s + u.robux, 0);
        await it.editReply(`**Previsão:** ${tot} liberando até ${p.lastDate || p.oldestDate || "?"} (±1 mês) • próxima: ${p.oldestDate || "?"} (${p.oldestRobux ?? "?"})`);
      } else if (n === "ticket") {
        const a = await api("/api/analytics?days=30");
        await it.editReply(`**Ticket médio (30d):** ${a.ticketMedio ?? "?"} • ${a.sales ?? "?"} vendas`);
      } else if (n === "compradores") {
        const a = await api("/api/analytics?days=30");
        const by = {};
        for (const t of (a.transactions || [])) {
          const nm = t.buyerName || "?";
          by[nm] = by[nm] || { name: nm, id: t.buyerId, vendas: 0, robux: 0 };
          by[nm].vendas++; by[nm].robux += t.robux || 0;
        }
        const lines = Object.values(by).sort((x, y) => y.robux - x.robux).slice(0, 5).map((b, i) => `${i + 1}. ${b.name} — ${b.vendas}x (${b.robux})`).join("\n") || "—";
        await it.editReply(`**Top compradores:**\n${lines}`);
      } else if (n === "resumo") {
        const [a, g, b] = await Promise.all([api("/api/analytics?days=7"), api("/api/group"), api("/api/balance")]);
        await it.editReply(`**${g.displayName || ""}** • ${g.memberCount ?? "?"} membros\n**7d:** ${a.sales ?? "?"} vendas • **${a.salesTotalRobux ?? "?"}**\n**Saldo:** ${b.disponivel ?? "?"} • **Pendente:** ${b.pendente ?? "?"}`);
      } else if (n === "ajuda") {
        await it.editReply("**Comandos:** /hoje /ultima /vendas /saldo /pendentes /previsao /ticket /compradores /ranking /membros /produto /resumo /ajuda");
      } else if (n === "produto") {
        const raw = it.options.getString("nome", true);
        const a = await api("/api/analytics?days=30");
        let hit = (a.ranking || []).find((r) => String(r.assetId) === raw);
        if (!hit) hit = (a.ranking || []).find((r) => (r.name || "").toLowerCase().includes(raw.toLowerCase()));
        if (!hit || !hit.assetId) return void it.editReply("Item não encontrado nos últimos 30 dias.");
        const d = await api(`/api/product/${hit.assetId}/sales?days=30`);
        const img = await thumb(hit.assetId);
        const em = new EmbedBuilder().setColor(0xff7a00).setTitle(`📦 ${d.name}`)
          .setFooter({ text: "Born to Dream • Roblox Analytics" })
          .addFields(
            { name: "Vendas", value: `${d.vendas}`, inline: true },
            { name: "Total", value: `${d.robux}`, inline: true },
            { name: "Top comprador", value: (d.buyers || [])[0] ? d.buyers[0].name : "—", inline: true },
          );
        if (img) em.setThumbnail(img);
        await it.editReply({ embeds: [em] });
      }
    } catch (e) {
      try { await it.editReply("Falha ao buscar. Tente de novo."); } catch {}
    }
  });

  client.login(token).catch((e) => console.log("[discord-bot] login:", e.message));
};
