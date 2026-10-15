// TESTAR-BOT.js — testa SÓ o Discord, sem o painel.
// Rode: TESTAR-BOT.bat   (ou: node TESTAR-BOT.js)
require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, Events } = require("discord.js");

const token = (process.env.DISCORD_TOKEN || "").trim();
const guild = (process.env.DISCORD_GUILD_ID || "").trim();
const say = (m) => console.log("[TESTE] " + m);

say("==============================================");
say("  TESTE DE CONEXAO DO BOT DISCORD");
say("==============================================");
say("DISCORD_TOKEN definido : " + (token ? "sim" : "NAO"));
say("  tamanho             : " + token.length + " caracteres");
say("  formato (3 partes)  : " + (token.split(".").length === 3 ? "ok" : "ESTRANHO - token de bot tem 3 partes separadas por ponto"));
say("DISCORD_GUILD_ID       : " + (guild ? guild : "nao definido (comandos globais)"));
say("");

if (!token) {
  say("FALHA: DISCORD_TOKEN nao esta no .env");
  say("  Pegue em https://discord.com/developers/applications");
  say("  -> sua aplicacao -> Bot -> Reset Token -> copie o TOKEN (nao o Client Secret)");
  process.exit(1);
}

if (token.split(".").length !== 3) {
  say("AVISO: esse token nao tem o formato de token de bot.");
  say("  Se voce copiou o 'Client Secret' ou 'Public Key', esta errado.");
  say("  O certo esta em: Bot -> Reset Token.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let pronto = false;
client.once(Events.ClientReady, async (c) => {
  pronto = true;
  say("CONECTOU! logado como " + c.user.tag + " (id " + c.user.id + ")");
  say("  servidores que o bot esta : " + c.guilds.cache.size);
  c.guilds.cache.forEach((g) => say("    - " + g.name + " (id " + g.id + ")"));
  if (guild) {
    const ok = c.guilds.cache.has(guild);
    say("  o DISCORD_GUILD_ID (" + guild + ") " + (ok ? "EXISTE nessa lista" : "NAO ESTA na lista -> erro de Guild ID"));
  }
  try {
    const rest = new REST({ version: "10" }).setToken(token);
    if (guild) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, guild), { body: [{ name: "ping", description: "teste" }] });
      say("  comandos registrados no servidor: OK");
    }
    say("");
    say("RESULTADO: BOT FUNCIONANDO. Se o painel nao conecta, o problema");
    say("           eh outro (memoria/rede do Render), nao o token.");
  } catch (e) {
    say("  comandos: FALHA - " + e.message);
    say("  -> o bot precisa da permissao 'applications.commands' no servidor");
  }
  process.exit(0);
});

client.on(Events.Error, (e) => say("ERRO: " + e.message));
client.on(Events.ShardError, (e) => say("SHARD: " + e.message));
client.on(Events.ShardDisconnect, (_e, code) => say("DESCONECTOU codigo " + code));
client.on(Events.ShardReconnecting, () => say("reconectando..."));
client.on(Events.Invalidated, () => say("SESSAO INVALIDADA - token revogado, gere outro"));

say("conectando ao gateway do Discord (20s de timeout)...");
const t = setTimeout(() => {
  say("");
  say("RESULTADO: NAO CONECTOU em 20 segundos.");
  say("Causas possiveis, na ordem:");
  say("  1. Token invalido ou revogado -> va em Bot -> Reset Token e pegue outro");
  say("  2. Token com espaco/quebra de linha -> revise o .env, nao pode ter aspas nem espaco");
  say("  3. Bot desconectado da internet no servidor (raro)");
  say("  4. Conta do bot sem 'Server Members Intent' (nao precisa pro nosso caso)");
  process.exit(2);
}, 20000);

client.login(token).then(
  () => say("token aceite pelo Discord, aguardando READY..."),
  (e) => {
    clearTimeout(t);
    say("");
    say("LOGIN REJEITADO: " + e.message);
    say("  -> token invalido/expirado. Gere um novo em Bot -> Reset Token.");
    process.exit(3);
  }
);
