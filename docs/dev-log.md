# Dev-Log — promo-radar-novo

Diário de bordo **append-only**. Cada despacho de trabalho entra aqui com `task_id`.
Formato: `data | task_id | autor | escopo | decisões | arquivos | evidências | próximo`.

---

## 2026-10-17 | E6-MONITOR-01 | planmaster | Implementar módulo MONITOR (RF-030–035)

**Contexto**: fork `promo-radar-novo` herdando tudo do `autoMensagemWhats`; adiciona o modo
MONITOR (receber de grupos de afiliados → trocar link → reencaminhar), sem quebrar o modo
AUTOMÁTICO. Ambos na mesma interface e compartilhando o contador diário por número (RN-013).

**Decisões**
- Estado persistido em `data/` (git-ignored, `chmod 600`): `monitor.json` (grupos) e
  `monitor-estado.json` (dedup + eventos), espelhando o padrão do projeto.
- Dedup de 7 dias por hash `programa|idProduto|linkTransformado` (RN-013/RF-035).
- Anti-loop: descarta `fromMe` e nunca envia de volta à origem (RN-010).
- Troca de link: ML reusa `converterLink` (TAG/COOKIE já testados); Amazon/Shopee/KaBuM
  aplicam parâmetro (`AMAZON_TAG`, `SHOPEE_SUBID`, `KABUM_REF`) e, sem config, vão para REVISÃO
  (nunca inventar link — RN-012).
- Webhook validado por `WEBHOOK_KEY` (header `X-Webhook-Key`), exceção à trava `MANAGER_KEY`.
- `MONITOR_GRUPOS`/`MONITOR_DESTINOS` (CSV de JIDs) semeiam o store quando vazio (Docker).

**Arquivos**
- `src/monitor/grupos.ts` — store origens/destinos, `MAX_MONITOR_GRUPOS=10`, `normalizarJid`,
  `ehMonitorado`, `destinosPara`, seed por env.
- `src/monitor/parser.ts` — allowlist de domínios, `classificar`, `extrairId`, `detectar`, `rotulo`.
- `src/monitor/transformer.ts` — `transformar` por programa.
- `src/monitor/state.ts` — dedup 7d + eventos + `resumo`.
- `src/monitor/webhook.ts` — `extrairMensagem`, `processar`, `montarRepasse`.
- `src/manager/server.ts` — endpoints e painel 📡 Monitor.
- `.env.example`, `.gitignore`, `tsconfig.json`.

**Endpoints novos**
`POST /api/webhook/evolution` · `GET/POST /api/monitor/grupos` · `POST /api/monitor/auto`
· `GET /api/monitor/status` · `POST /api/monitor/testar`.

**Evidências**
- `npm run typecheck` limpo; `npm run build` OK (`dist/monitor/*`).
- Smoke test parser: reconhece ML/Amazon/Shopee/KaBuM e extrai IDs (MLB/ASIN/numérico).
- Smoke test fluxo: própria→IGNORADO, não monitorada→IGNORADO, sem link→REVISÃO,
  Amazon c/ TAG→ENCAMINHADO (dry-run), repetida→DUPLICADO, ML sem cookie→REVISÃO.
- HTTP: webhook sem chave→401; com chave→ENCAMINHADO (`?tag=meucanal-20`); add/remove grupo,
  status, testar e auto ON/OFF todos 200.

**Próximo**: configurar webhook na Evolution (`messages.upsert` → `http://<host>:8091/api/webhook/evolution`
com `X-Webhook-Key`); cadastrar as origens/destinos reais; validar ponta a ponta em ambiente.

---

## 2026-10-17 | E6-MONITOR-02 | planmaster | Setup, docs e validação de deploy

**Decisões/achados**
- Fork estava sem infra do core → trazidos `Dockerfile.manager`, `docker-compose.go.yml`,
  `README.md`, `.github/workflows/ci.yml`, `scripts/migrar-*.sh`, `.gitignore`, `tsconfig.json`.
- `develop` criada; 4 commits; `.env` do fork gerado a partir do original (chmod 600) + vars do monitor.
- Imagem `promo-radar-manager:latest` construída (não mexe no container antigo `automensagem_manager`).

**Evidências**
- Correção de 2 bugs de sintaxe no JS inline da página (aspas aninhadas no `onclick` →
  trocado por `dataset`; `\n` em template literal → `\\n`). Página validada (JS 13.947 chars OK).
- `node dist/manager/server.js` com `.env` real: boot ok, `/` 200, `/api/monitor/*` ok,
  webhook sem chave → 401 (WEBHOOK_KEY aplicada).

**Bloqueio**
- Instância Evolution `radar-piloto` em estado `connecting` (não pareada) → `inviteInfo` não
  resolve o convite e `fetchAllGroups` retorna "Connection Closed". QR salvo em
  `qr-radar-piloto.png`. Ação humana: escanear o QR (WhatsApp → Aparelhos conectados).

**Próximo**: parear a sessão; resolver o JID do grupo de teste via `group/inviteInfo`; definir
deploy (substituir container antigo ou porta separada); configurar o webhook `messages.upsert`.

---

## 2026-10-17 | E6-MONITOR-03 | planmaster | Deploy 8099 + webhook + E2E real (via `restart`)

**Diagnóstico**: instância `radar-piloto` presa — `fetchInstances` dizia `connectionStatus:open`
(conta "Eletrônica", `5500000000002`) mas o socket Baileys estava `Connection Closed`. **`POST
/instance/restart/{inst}`** (não `PUT`) derrubou/religou o socket e voltou para `open`.

**Feito**
- Deploy: `promo_radar_manager` na **8099** (rede `automensagemwhats_default`); imagem rebuikada.
- Convite resolvido: `INVITE_REDACTED_0000000` → **`120363000000000001@g.us`** ("Mano dos Achadinhos").
- Origem = Mano dos Achadinhos; Destino = **"Radar Teste"** (`120363000000000002@g.us`).
- Webhook: `POST /webhook/set/radar-piloto` → `http://promo_radar_manager:8091/api/webhook/evolution`,
  `events:[MESSAGES_UPSERT]`, header `X-Webhook-Key` (chave 24 bytes gerada, no `.env`).

**Bug corrigido**: `processar()` **ignorava o flag `autoEnviar`** (enviava mesmo com "OFF/vai p/
revisão"). Agora, com `autoEnviar=false`, registra `REVISAO`; só envia quando ligado.

**E2E real (passou)**
- Produto ativo ML (`MLB-6467824944`) → transformado em **`https://meli.la/1TZpZHA`** (tag ecoada).
- Webhook → `acao:ENCAMINHADO` → mensagem **entregue de verdade** no "Radar Teste" (`msgId 3EB0FD69...`).
- Reenvio da mesma oferta → `DUPLICADO` (dedup 7d). Mensagem própria (`fromMe`) → `IGNORADO` (anti-loop).
- Estado de teste limpo; grupos mantidos; `autoEnviar=true`.

**Achados operacionais**
- API pública do ML está bloqueada (403 PolicyAgent) p/ descoberta de produtos; IDs de catálogo
  `/p/MLB` não servem no `createLink` (só item `MLB-<id>` ativo). Erros do ML: `URL Invalid.`,
  `article must be active, status: paused`.
- `AMAZON_TAG`/`SHOPEE_SUBID`/`KABUM_REF` ainda vazios → esses programas caem em REVISAO até configurar.

**Próximo**: definir `AMAZON_TAG`/`SHOPEE_SUBID`/`KABUM_REF`; validar com oferta real postada no
grupo de origem; decidir substituição futura do manager antigo (8091).

---

## 2026-10-17 | E6-MONITOR-04 | planmaster | Regras origem→destino + celular correto

**Feedback do usuário**: separar origem/destino ficou "vago" — como cada grupo publica uma
categoria, todas as origens caíam no mesmo destino. Precisava de **associação 1:origem → N
destinos** e card menos embolado.

**Feito**
- `grupos.ts` reescrito: `regras[]` (cada origem com os seus destinos). `adicionarRegra` liga
  **1 origem a 1 destino por vez**; `removerDestino` / `removerRegra`. **Migra** o formato antigo
  (origens[]+destinos[]) sem perder config.
- `webhook.ts`: `destinosPara(origem)` devolve **só** os destinos daquela origem.
- UI reorganizada em blocos: Conexão (conta/trocar celular), Envio direto, **Nova regra** (2
  selects origem/destino) e **Regras ativas** em cartões `origem → destinos`, com ✕ por destino.
- Endpoints novos/refeitos: `/api/monitor/grupos` (regras), `?forcar=1` em whats-grupos (cache 10min),
  reiniciar/desconectar.

**Celular trocado**: conta atual deslogada; usuário pareou o celular certo — agora
**"Reginaldo" (`5500000000001`)**, estado `open`.

**Testes (dry-run, sem enviar)**: origem A→2 destinos = ENCAMINHADO [X,Y]; origem B→1 destino =
ENCAMINHADO [X]; origem não cadastrada = IGNORADO; repetida = DUPLICADO.

**Estado**: 6 origens reais do usuário (Epipe Tech, Royal Masculine, RADAR DAS PROMOS #24, Promos de
Brother, Vasculha, Herói do Perfume) — todas ainda apontando p/ "Mano dos Achadinhos"; `autoEnviar`
**OFF**. Falta o usuário dar destino próprio a cada origem.

**Próximo**: usuário monta as regras reais pela UI; definir tags Amazon/Shopee/KaBuM.

---

## 2026-10-17 | E6-MONITOR-05 | master | Link curto + formato anterior com foto

**Feedback do usuário (2 issues)**
1. O repasse deve ter o **formato anterior** — não só o texto, também a formatação e a **foto do produto**.
2. O sistema **recebia mas não tratava/reenviava** as mensagens reais.

**Diagnóstico** (capturado do webhook real, `MONITOR_DEBUG=1`)
- Causa 1: as mensagens reais usam **link curto** `https://meli.la/XXXX` (ex.: `meli.la/2GQWuZ8`),
  que **não contém o MLB id**. O `createLink` exige o id → 77 eventos `REVISAO`.
- Causa 2: o `montarRepasse` preservava só o texto original + rodapé — sem foto/formatação.

**Feito**
- **`src/monitor/produto.ts`** (novo): `resolverProdutoML()` segue o redirect do link curto (UA de
  browser) e extrai **MLB id + og:title + og:image** da página do anúncio; `imagemCompativel()`
  troca `.webp → .jpg` (mlstatic serve ambos; WhatsApp lida melhor com jpg). `extrairPrecos()`
  lê "De:/Por:" do texto (fallback maior=De, menor=Por).
- **`transformer.ts`**: ML agora **resolve o link curto antes** de converter (`produto.id` →
  `https://produto.mercadolivre.com.br/MLB-<id>` → createLink). Devolve `produto` no resultado.
- **`webhook.ts`**: `montarRepasse()` usa o **template anterior** (RN-001 v3: 🔥 título + `~De~` /
  `*Por ... no Pix*` / parcelas + link) quando há título+preço; senão cai no formato preservado.
  Envia a **foto** via `enviarParaGrupo({ imagem })` → `sendMedia`.
- `server.ts`: log opt-in `MONITOR_DEBUG=1` do payload cru (debug do parser).

**Provas (E2E real)**
- Link curto `meli.la/2GQWuZ8` → MLB `3573257631` → `createLink` **200** (tagOk) → `meli.la/32dnmmo`
  em ~0,5s.
- Webhook real com o texto do hunter: `acao: REVISAO (autoEnviar=false)`, mensagem montada no
  **formato anterior** com `De R$ 202,90` / `Por R$ 98,80 no Pix` / `Ou R$ 109,67 em 6x`.
- Envio real com `autoEnviar=ON` (destino temporário "Radar Teste"): `ENCAMINHADO`
  messageId `3EB06A0E9E8568B000F705`. `sendMedia` da og:image `.jpg` → Evolution monta
  `imageMessage` (messageId `3EB03258CED6327292BE23`).

**Estado**: `autoEnviar` **OFF** (restaurado); 6 regras → Mano dos Achadinhos intactas.
**Nota**: modo automático e monitor **sem limite diário** (removido a pedido).
**Próximo**: decidir se liga `autoEnviar` (passa a reenviar as 6 origens de verdade).

---

## 2026-10-17 | E6-MONITOR-06 | master | Id de anúncio (não catálogo) + alerta de envio

**Feedback**: "adicionei os botões on/off em cada regra, mas mesmo com dois ligados não está enviando".

**Diagnóstico (2 causas)**
- **Causa A (bug real)**: a página do anúncio traz **vários** `MLB-<id>`. O `extrairMlbId` pegava o
  **primeiro** — que é o de **catálogo** (`/p/`, 11–12 dígitos) — e o `createLink` devolve
  `CREATELINK_SEM_URL`. Prova: `MLB-114676227034` (catálogo) **falha**; `MLB3608500451`
  (`"item_id"`) **passa**.
- **Causa B (UX)**: o envio depende de **dois** interruptores — o toggle de cada regra (origem/destino)
  **e** o mestre "Envio direto". Com `autoEnviar=false`, tudo cai em REVISAO mesmo com regra ligada
  (motivo registrado: "envio direto desligado — aguardando revisão").

**Feito**
- `produto.ts`: `extrairItemId()` prioriza `"item_id":"MLB…"` / `"id":"MLB…"` (id do ANÚNCIO) antes
  do `MLB-<id>` genérico.
- UI: alerta `#malerta` — vermelho quando há regra ligada com envio direto OFF ("nada será enviado");
  âmbar quando o envio está ON mas nenhuma regra ativa; verde quando reenviando.

**Provas**: os 7 links que falhavam agora resolvem+convertem (**7/7**) —
`22VssKG→2sqTcXw`, `2iX9hWQ→2pvyf8d`, `1Gp8Rch→1AXkMvi`, `2MrCkJB→1zmez5e`, `2wpFZSo→2gnDK9i`,
`2pMqCy2→2owyi5z`, `1ZhqeWM→2tXDpvE`. Alerta renderizado nos 2 estados (OFF→vermelho, ON→verde).

**Estado**: `autoEnviar` ainda **OFF**; 2 regras ligadas pelo usuário (RADAR DAS PROMOS #24 e
PROMOS DE BROTHER 470 → Mano dos Achadinhos).

---

## 2026-10-17 | E6-MONITOR-07 | master | Id do anúncio validado por título + dedup por produto

**Continuidade do feedback**: com 2 regras ligadas ainda não enviava.

**Causa C (bug real, o mais sério)**: a página do link curto traz **vários** `MLB-<id>` — o
`item_id` é o anúncio, o `wid=` costuma ser **relacionado** e o `/p/` é **catálogo** (o createLink
rejeita). Pegar "o primeiro" ora dava certo, ora apontava para **outro produto** (foto de um, link
de outro). Provas medidas:
- `2iX9hWQ`: `item_id MLB-4210056475` → título **confere**; `wid MLB-4811253949` → "Relógio Wokai"
  (**produto diferente**).
- `22VssKG`: `item_id MLB-3608500451` → confere; `wid MLB-4484499507` → "Kit 5 Camisetas"
  (diferente).
- Super Groom: o `item_id` é **catálogo** (`/p/MLB44784310`, 8 dígitos) → createLink rejeita.

**Feito**
- `produto.ts`: `idsCandidatos()` devolve candidatos em ordem (`item_id` → `wid` → `/p/` → genérico);
  `.webp→.jpg`.
- `transformer.ts`: para cada candidato, gera o link e **valida resolvendo o próprio link de volta**
  e comparando o `og:title` com o do deal. Só aceita o produto igual; senão guarda o 1º que
  converteu como reserva. Fonte do título = o do deal; imagem = a do produto **validado**.
- `state.ts`: dedup passa a chavear por **programa+idProduto** quando há id (o createLink devolve um
  link NOVO a cada chamada — antes o mesmo produto postado 2x duplicava no grupo).
- `webhook.ts`: `idEfetivo` (id resolvido) usado no dedup/eventos.

**Provas**: 8/8 links convertidos **e** 8/8 apontando para o **mesmo produto** do anúncio original
(comparando o título do link devolvido com o do link original).

**Envio direto LIGADO** a pedido do usuário. Reenvios reais confirmados: 2 msgs de PROMOS DE BROTHER
470 → Mano dos Achadinhos (msg `3EB0ED913579809D56C6CC`, `3EB0A2B5646DD423C50537`), com **foto**
(`imageMessage` no log da Evolution, legenda "🔥 Kit 4 Camiseta Dry Fit Parvori…").

**Ressalva**: os 2 reenvios feitos na janela anterior à validação por título podem ter apontado para
um produto relacionado — vale conferir no grupo.
