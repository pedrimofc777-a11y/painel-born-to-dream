# Born to Dream — Dashboard

Painel de analytics para grupo do Roblox (vendas em Robux, membros, saldo, produtos).

## O que foi instalado nesta atualização

| Recurso | Onde |
|---|---|
| Login com senha + cookie assinado (HMAC) | `lib/guard.js`, `public/login.html` |
| Rate limit por rota + global | `lib/guard.js` |
| Cabeçalhos de segurança (CSP, HSTS, X-Frame) | `lib/guard.js` |
| `/healthz` para monitorar uptime | `server.js` |
| Exportar vendas em CSV | `/api/export/csv` |
| Metas configuráveis na tela | aba **Assistente** → 🎯 Metas |
| Backoff exponencial quando o Roblox recusa | `lib/backoff.js` + `/api/analytics` |
| Persistência externa opcional (Upstash Redis) | `lib/store.js` |
| Logs com nível + arquivo rotativo | `lib/logger.js` → `data/logs.jsonl` |
| 404 JSON em rota de API inexistente | `server.js` |

## ⚡ Como atualizar (comando único)

Abra o **CMD** dentro da pasta `Born_to_Dream_Roblox_Analytics_v25` e execute:

```
ATUALIZAR.bat
```

Ele instala as dependências, completa o `.env` com as chaves novas, checa a
sintaxe de todos os arquivos, cria as pastas que faltam e testa se o servidor sobe.

Para rodar depois:

```
npm start
```

## 🔑 Configuração obrigatória (1 vez)

Abra o arquivo `.env` e defina uma senha para o painel:

```
PANEL_PASS=sua_senha_aqui
```

Sem isso o painel fica aberto em produção. A tela de login aparece em `/login.html`
e a sessão dura 30 dias no navegador.

## 💾 Persistir os dados no Render (recomendado)

O disco do Render é apagado em restart/deploy. Para os dados sobreviverem:

1. Crie um banco grátis em https://console.upstash.com → **Redis** → **REST API**
2. Copie `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`
3. Cole no `.env` (e nas variáveis de ambiente do Render):

```
KV_REST_API_URL=https://xxxxxx.upstash.io
KV_REST_API_TOKEN=xxxxxxxxxxxxxxxx
```

Sem isso, o painel continua funcionando — só perde o snapshot salvo entre deploys.

## 📊 Exportar planilha

- Botão **⤓ Exportar CSV do período** na aba Assistente
- Ou acesse `/api/export/csv?days=30` direto
- Abre no Excel/Google Sheets com data, hora, item, comprador e valor

## 🎯 Metas

Aba **Assistente** → bloco **🎯 Metas**. Digite os valores separados por vírgula
(ex.: `100,500,1000,5000`) e o período. A barra de progresso usa os últimos 30 dias
e o confete dispara uma única vez por meta batida.

## 🔒 Acesso por script/API

Além do cookie, dá para autenticar por header:

```
curl -H "Authorization: Bearer SUA_SENHA" https://seu-painel/api/analytics?days=7
```

## 🩺 Monitorar uptime

`/healthz` retorna status, uptime, uso do cache e se o cookie do Roblox está ok.
Aponte o https://cron-job.org ou https://uptimerobot.com para ele.

## 🪵 Logs

`data/logs.jsonl` — últimas ~2500 linhas, com nível (`LOG_LEVEL=debug` para mais detalhe).

## 🛡️ Rate limits

| Rota | Limite |
|---|---|
| global | 300 req/min por IP |
| `/api/login` | 12 tentativas / 5 min |
| `/api/analytics` | 30 req/min |
| `/api/chat` | 12 req/min |
| `/api/members/search` | 30 req/min |
| `/api/product/*` | 40 req/min |
| `/api/pending` | 20 req/min |
