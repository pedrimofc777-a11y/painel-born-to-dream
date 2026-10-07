# Born to Dream — Roblox Analytics

Dashboard inicial em tema laranja + preto para o grupo Vynz UGC (ID 190007685).

## Segurança
A chave da Roblox **não fica no frontend** e não deve ser enviada pelo chat.
Ela é lida apenas pelo servidor através de `ROBLOX_API_KEY`.

## Instalação
1. Instale Node.js 18+.
2. Copie `.env.example` para `.env`.
3. Abra `.env` e substitua `COLE_SUA_CHAVE_AQUI` pela sua API Key.
4. Rode:
   `npm install`
   `npm start`
5. Abra `http://localhost:3000`.

## O que já está pronto
- Layout responsivo Born to Dream
- Tema laranja/preto
- Cards de métricas
- Dados reais do grupo via Roblox Open Cloud Groups
- Group ID configurado: 190007685
- A API Key nunca é exposta ao navegador
- Receita, vendas, ticket médio, ranking de produtos, gráficos e insights **não usam dados de demonstração**; ficam como "Não disponível" enquanto não houver autenticação compatível.

## Limitação atual da Roblox
Os endpoints de transações e resumo de receita do grupo aparecem atualmente na documentação como autenticação por Cookie, enquanto os endpoints Open Cloud de Groups aceitam API Key/OAuth. Portanto, esta versão conecta com segurança os dados de grupo disponíveis pela chave e **não exibe números inventados para receita, vendas ou produtos**. Esses dados ficam como "Não disponível" até definirmos uma fonte de dados compatível.

Fontes oficiais:
- https://create.roblox.com/docs/cloud/reference/features/groups
- https://create.roblox.com/docs/pt-br/cloud/reference/domains/economy
