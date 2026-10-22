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

---

## 2026-10-17 | E6-MONITOR-08 | master | Fila anti-rajada (45s) + botões de reset

**Pedido**: (1) botão para resetar contadores; (2) se uma origem postar várias mensagens
em pouco tempo, segurar em espera e liberar 1 a cada 45s (teste inicial).

**Feito**
- `src/monitor/fila.ts` (novo): fila FIFO persistida em `data/monitor-fila.json`
  (`enfileirar`, `tamanhoFila`, `limparFila`, `liberarProximo`, `iniciarFilaWorker`).
  Worker checa a cada 5s e libera **1 item a cada `MONITOR_FILA_INTERVALO_S`** (default 45).
  Fila ociosa → o 1º item sai no próximo tick; depois é 45s entre cada um.
  Não envia `ENFILEIRADA` quando `autoEnviar=false` (segura a fila).
- `webhook.ts`: produção agora **enfileira** (`acao: "ENFILEIRADO"`, evento `ENFILEIRADA`)
  em vez de enviar na hora; `dryRun` (teste da UI) continua enviando simulado na hora, sem
  tocar na fila. `marcarMonitorado` no enfileiramento (reserva contra re-enfileirar).
- `state.ts`: status novo `ENFILEIRADA`; `zerarContadores()` e `limparDedup()`.
- `server.ts`: inicia o worker no boot; `/api/monitor/status` devolve `fila` e `intervaloFila`;
  `POST /api/monitor/zerar` com alvo `contadores|dedup|fila|tudo` (**alvo inválido → 400, não zera**).
  UI: linha "🚦 fila anti-rajada: N em espera · 1 a cada 45s (≈ M min p/ esvaziar)" + 3 botões
  (Zerar contadores / Limpar dedup / Esvaziar fila).
- **Robustez**: `carregar()` em `state.ts`/`fila.ts` mantém cache da última leitura boa e a
  gravação virou **atômica (tmp+rename)** — um erro transitório de I/O não devolve mais estado
  vazio (e a próxima escrita não persiste o vazio). Suspeita da perda do histórico de eventos.

**Provas**
- Drip controlado (destinos vazios, sem enviar): 3 enfileirados → 1ª liberação imediata (fila ociosa),
  2ª imediata **BLOQUEADA** (correto), depois 1 a cada 45s (46s→ok, 92s→ok) → fila 0.
- Real: `14:05:44 ENFILEIRADA` (fila: 1) → `14:05:49 ENCAMINHADA` (fila ociosa, saiu no tick de 5s).
- Estado sobreviveu a 2 `--force-recreate` (cache + escrita atômica).
- `alvo:"naoexiste"` → 400 e contadores intactos.

**Observação**: `disparo real` hoje só sai por `Royal Masculine | 1` (o usuário trocou as regras
pela UI); as demais origens estão off.

---

## 2026-10-17 | E6-MONITOR-09 | master | Foto da origem (mesma imagem do post)

**Pedido**: usar a MESMA foto que a origem publica, em vez da `og:image` do anúncio.

**Descoberta**: a foto da origem vem no próprio webhook — basta ligar `webhookBase64` na
instância (`POST /webhook/set/{inst}` com `{webhook:{...,base64:true}}`; o campo no SET é
`base64`, a resposta traz `webhookBase64`). Com isso, todo `imageMessage` chega com
`data.message.base64` (irmão de `imageMessage`), ex.: `string(267348)` + `mimetype: image/jpeg`.
- A rota `POST /chat/getBase64FromMediaMessage/{inst}` existe, mas **não serve** aqui: a tabela
  `Message` do Evolution está vazia (`DATABASE_SAVE_DATA_NEW_MESSAGE=false`) → "Message not found".
- Confirmado também que `sendMedia` aceita **base64** (teste real, 200 + messageId).

**Feito**
- `src/monitor/midia.ts` (novo): `salvarMidia(base64,mime)`, `ehArquivoMidia`, `lerMidia`,
  `limparMidiaAntiga(dias)`. Salva em `data/midia/<uuid>.<ext>` — **não** embute o base64 na
  fila/estado (seriam dezenas de MB de JSON).
- `webhook.ts`: `MensagemExtraida.midia` (base64+mimetype); a foto escolhida é
  **origem → fallback og:image**; `MONITOR_FOTO=produto` inverte a prioridade. A fonte escolhida
  vai no `detalhe` do evento ("foto da origem" / "foto do anúncio") e no item da fila.
- `dispatch.ts`: `enviarParaGrupo` reconhece caminho de arquivo local como foto; `enviarMidia`
  lê o arquivo e manda em base64 (mimetype pela extensão).
- `fila.ts`: item carrega `fonte`; worker limpa `data/midia` com +3 dias (1x/hora).
- **Segurança**: `MONITOR_DRY=1` força dryRun em TUDO (processar + worker) — nenhum envio real sai.

**Provas**
- Sintético com `base64`: evento `ENCAMINHADA … · foto da origem` e arquivo em `data/midia/`.
- Sintético com `MONITOR_FOTO=produto`: evento `… · foto do anúncio` (og:image).
- Envio real a partir de ARQUIVO em disco → base64 → `sendMedia` 200 (`3EB0532758736CE56B1055`).
- Tráfego real: origens do Royal Masculine postam **texto** → cai no fallback "foto do anúncio".
- `MONITOR_DRY=1` → `messageId: dryrun-…` (nada real enviado).

**Incidente (erro meu, registrar)**: ao testar, chamei `processar()` sem `dryRun` → o item entrou
na fila e **foi enviado ao grupo real** (Mano dos Achadinhos, msg `3EB092BAE0A58883D968B9`,
produto MLB3573257631) com uma imagem de teste 1x1. Tentei apagar via
`DELETE /chat/deleteMessageForEveryone/radar-pelo` → 428 "Connection Closed" (Baileys não apaga
sem store de mensagens). Mensagem permanece no grupo — remover manualmente. Por isso `MONITOR_DRY`.

---

## 2026-10-17 | E6-MONITOR-10 | master | Seletor de foto na UI + pausa do piloto explícita

**Pedido 1**: trocar a flag de ambiente (`MONITOR_FOTO`) por um **seletor na UI**.

**Feito**: a fonte da foto agora é config persistida em `data/monitor.json`:
- `MonitorStore.foto: "origem" | "produto"` (novo; `carregarMonitor()` lê, default `origem`).
- `definirFoto(v)` em `src/monitor/grupos.ts`.
- `src/monitor/webhook.ts`: `fotoDaOrigemPrimeiro()` lê `carregarMonitor().foto` (env `MONITOR_FOTO` **aposentada**).
- API: `GET /api/monitor/grupos` devolve `foto`; novo `POST /api/monitor/foto {foto}`.
- UI (painel 📡 Monitor): linha "Foto do repasse: a da ORIGEM (mesma do post) / a do ANÚNCIO (og:image)"
  com dois botões ("Da origem" / "Do anúncio"); o ativo fica `.ok`.

**Provas**: `foto:origem → POST produto → monitor.json.foto=produto`; repasse dry-run passou a
`imagem=https://http2.mlstatic.com/...jpg` com detalhe `· foto do anúncio`; voltando para `origem`
tudo igual antes. Valor inválido cai no padrão `origem` (sem quebrar).

**Pedido 2**: `#1-principal` parou de gerar mensagens (11:08 locais).

**Causa**: `store()` em `src/ml/piloto.ts` forçava `rodando:false` em memória no boot (pausa por
segurança) **mas não chamava `salvar()`** — o arquivo continuava `rodando:true`, então a grade
parecia ligada sem estar. Qualquer `--force-recreate` pausava os loops silenciosamente.

**Feito**: a pausa agora é **persistida** e **anunciada** no log do piloto:
`⏸ N loop(s) pausado(s) após reinício — clique em ▶ START (ou ▶ LIGA TUDO) para religar.`

**Nota operacional**: `▶ LIGA TUDO` (`POST /api/auto/ligar`) depende do **mapa** categoria→conta+grupo
(`data/mapa*.json`) e ele está **vazio** — por isso o LIGA TUDO responde "Nenhuma categoria amarrada".
Religar um perfil = `POST /api/piloto/start` com `{conta, category, grupo, sub, qtd, intervaloS}`.

**Provas**: logs com o ⏸ e `loops[].rodando=false` no arquivo; após religar,
`id 1 · enviadas 1 · ultimaMsg 15:38:14Z` e `✅ [caça LIVE|principal] ... id=3EB0D540F8486D5006DA92`.

---

## 2026-10-19 | E6-MONITOR-11 | master | Piloto: filtro por palavra no loop

**Pedido**: um campo de filtro por palavra ao lado de "Intervalo entre elas", para o loop
publicar só o que interessa ao grupo.

**Feito**:
- `PilotoCfg.filtro` + `LoopState.filtro` (persistido no `piloto.json`).
- `start()` copia o filtro (antes montava o loop com lista explícita e **descartava**).
- `hunt({ q: filtro })`: a palavra também entra na **busca** do ML (não só no pós-filtro).
- Pós-filtro no título vale para TODAS as fontes (caça, vitrine, cesta): normaliza acento/caixa
  e exige **todas** as palavras (AND). Sem casar nada -> `filtro "X" não encontrou nada` e aguarda;
  nunca envia fora do escopo.
- UI (painel ⚙ Automático): input "Filtro por palavra (opcional)" ao lado de "Intervalo entre elas";
  `POST /api/piloto/start` aceita `filtro`; o START loga `· filtro "..."`.

**Provas**:
- `hunt` com `q="perfume"` -> 18 itens de perfume; `q="air fryer"` na categoria de perfumes -> 3 itens
  (e o pós-filtro derrubaria o relógio que veio junto).
- Loop com `filtro:"zzzznaoexiste"` e 1 item na cesta -> `enviadas: 0` e
  `#1 filtro "zzzznaoexiste" não encontrou nada nesta volta — aguardando.`
- `loop.filtro` aparece salvo no status; cesta de teste removida depois.

---

## 2026-10-19 | E6-MONITOR-12 | master | Dispatch: retry em erro transitório da Evolution

**Sintoma**: `#1 falha em MLB-6642966774 (Evolution sendMedia 500 ...), tentando próximo.`

**Diagnóstico** (não era a imagem): no mesmo horário a Evolution registrou **51 `Connection Closed`
/ `Precondition Required` entre 10:04 e 10:09**, e o estado da instância ficou `open` desde então.
- `connectionState` = `open` e estável (3 leituras); `disconnectionReasonCode: 401` é **evento velho**
  de 17/10 (`disconnectionObject.date = 2026-10-17T04:15:56Z`), não a causa.
- Container da Evolution **baixa** `http2.mlstatic.com` (HTTP 200) → não é rede/imagem.
- `sendMedia` para o grupo de TESTE com a mesma imagem → **200** (`3EB039C76C6096E76E66F8`).
- Ou seja: **surto transitório** de conexão do WhatsApp; o item era descartado no meio.

**Feito** (`src/wa/dispatch.ts`): `comRetry()` com backoff (2s, 4s) só para erro transitório
(`5xx`, `Connection Closed`, `Precondition Required`, `ECONNRESET/REFUSED/TIMEDOUT`, `fetch failed`,
`socket hang up`). Aplicado em `sendText` e `sendMedia`. Erro definitivo (4xx) falha na hora.

**Provas**:
- `EVO_URL` inalcançável → `repetindo em 2s (2/3)`, `repetindo em 4s (3/3)`, desiste em **6.3s**.
- Envio real de mídia no grupo de teste após a mudança → `OK: 3EB0B52944B66330600CB5`.

---

## 2026-10-19 | E6-MONITOR-13 | master | Multi-número com rodízio aleatório ponderado

**Pedido**: cadastrar outros celulares (em vez do "Trocar celular", que desloga) e enviar
as mensagens alternando entre eles, até 5, para não concentrar tudo num número só.

**Decisões do produto** (via question): rotação vale para **tudo** (piloto + monitor);
sorteio **aleatório ponderado**; número **desconectado é pulado**; conta ML continua a **principal**.

**Feito**:
- `src/wa/rotacao.ts` (novo): store `data/instancias.json` (`instancia`, `nome`, `ativo`, `peso`,
  `enviadas`, `ultimaEm`), `MAX_INSTANCIAS=5`, cache de estado com TTL 45s, `proximaInstancia()`
  (ponderado, só `open`; se todos fechados ainda sorteia um ativo p/ o retry), `registrarEnvio()`,
  `adicionarInstancia()` (cria na Evolution + webhook com `webhookBase64:true` + QR),
  `qrInstancia()`, `definirAtivo/Peso`, `removerInstancia()` (apaga na Evolution também).
- `src/wa/dispatch.ts`: `comRetry(fn(instancia))` — **cada tentativa sorteia de novo**, então
  se o número caiu a repetição já sai por outro. `sendText` e `sendMedia` usam a instância sorteada.
- Rotação no dispatch ⇒ vale para o piloto **e** para os repasses do monitor (fila incluída).
- Webhook de novas instâncias já nasce com `base64` (foto da origem).
- UI: card "📱 Números para envio rotativo" (lista com estado/peso/envios, ➕ Adicionar celular,
  QR inline, ativar/desativar, peso 1–10, remover).
- `webhookBase64: false` → `true` em `monitor/evolution.ts` (armadilha que desligaria a foto da origem).

**Provas**:
- Seed: `Celular 1 | radar-piloto | open`.
- Criada instância de teste: apareceu `connecting` e o sorteio a **pulou 5/5**
  (`radar-piloto, radar-piloto, ...`) — "pula desconectado" ok. Removida em seguida.
- Envio real pelo dispatch: `3EB096FD90F264DCB9CAD0`; `instancias.json` gravou `enviadas: 1`.
  (O contador não apareceu na hora no `GET` porque o teste rodou em **outro processo**, com cache
  próprio; no processo do servidor — que é quem envia — o cache é o mesmo.)

### Hotfix E6-MONITOR-13 | botão "Adicionar celular" não funcionava
**Causa**: o card é gerado dentro de um template literal; os `\'` dos `onclick` foram
consumidos na interpolação, o JS servido saiu como `verQR(''+i.instancia+'')` e o
**script inteiro** falhava no parse (por isso nada do painel respondia).
**Fix**: `\\'` no fonte (chega como `\'` no HTML). Validação: extraí o `<script>` servido e
rodei `node --check` → OK; `POST /api/instancias` cria e devolve QR (data URI 13 KB).

### E6-MONITOR-14 | select de grupo do piloto demorava/vazio
**Sintoma**: "Grupo de destino" do piloto automático não listava os grupos.
**Causa provável**: `/api/grupos` chama `fetchAllGroups` da Evolution e leva ~10s (medido 9,7s);
o select só era preenchido no fim de `carregarContas()` e, sem feedback, parecia travado.
**Fix**: cache de 60s no backend (`?refresh=1` força), estado "carregando… (pode levar 10s)",
`try/catch` com opção de erro clicável, `carregarGrupos()` chamado direto no init e
recarregamento no `focus` do select quando vazio.
**Prova**: 1ª chamada 9,77s → 2ª 0,02s (`cache:true`), 33 grupos; `<script>` servido passa no `node --check`.

---

## 2026-10-19 | E6-MONITOR-15 | Emipe não repassava + fila só para rajada

**Diagnóstico (payload real capturado com MONITOR_DEBUG)**: a `#55 Emipe Promoções Tech`
usa **mensagens temporárias** — todo post chega como `tipos:["ephemeralMessage"]`, com o
texto/imagem um nível abaixo (`message.ephemeralMessage.message`). O `extrairMensagem` só
olhava o topo e devolvia `"sem texto"` → 183 mensagens entre 11:09–11:15 UTC foram descartadas.
**Fix**: `desembrulhar()` recursivo para `ephemeralMessage`, `viewOnceMessage(V2)`,
`documentWithCaptionMessage` e `editedMessage`; `base64` lido no envelope interno ou externo.

**Fila (pedido do usuário)**: antes TODA mensagem entrava na fila (1 a cada 45s).
Agora:
- até **3 mensagens da mesma origem por minuto** → envio **imediato**;
- da **4ª em diante** → fila, liberada **1 a cada 120s** (`MONITOR_FILA_INTERVALO_S`);
- a janela conta só mensagens válidas (depois de dedup/link/destino);
- UI já mostra `🚦 fila anti-rajada: N em espera` e o ETA — `N` cai a cada liberação.

**Provas**:
- `extrairMensagem` com payload ephemeral → texto + base64 extraídos; normal segue ok.
- `ehRajada` 5 chamadas: `false,false,false,true,true`; após 61s volta a `false`.
- Ponta a ponta (webhook real): 3 primeiras `ENCAMINHADO`, 4ª `ENFILEIRADO`, `fila:1`;
  `ultimoEnvio` 15:05:31 → liberada 15:07:31 (120s), `fila:0`.
- Os 3 envios de teste usaram imagem falsa (`QUJD`) → Evolution 500 e **nada foi postado**;
  `monitor.json` não foi alterado (a edição local falhou por permissão root).

---

## 2026-10-19 | E6-CLIENTES-01 | Card CLIENTES + títulos editáveis por painel

**Pedido**: (1) nomear cada card; (2) gerenciar contatos por celular cadastrado e disparar
propaganda individual ou para listas de distribuição. Decisões do usuário: contatos vêm dos
**participantes dos grupos** + cadastro manual; intervalo de disparo é livre (default 60s).

**Diagnóstico da fonte de contatos**: `POST /chat/findContacts` e `/chat/findChats` da Evolution
retornam `[]`; `fetchAllGroups?getParticipants=true` → 500; `findGroupInfos` estoura timeout em
grupo grande. **Funciona**: `GET /group/participants/{instance}?groupJid=` (rápido; sem nomes;
entradas `@lid` sem `phoneNumber` são ignoradas).

**Entregue**:
- `src/clientes/clientes.ts`: contatos persistidos em `data/clientes.json`, listas e fila em
  `data/clientes-fila.json`; sync em background (33 grupos, progresso consultável); campanha com
  envio 1 a cada `CLIENTES_INTERVALO_S` (default 60) via rotação de números.
- `src/ui/titulos.ts`: títulos por card em `data/ui.json` (`piloto`, `monitor`, `numeros`, `clientes`).
- `src/manager/server.ts`: endpoints `/api/ui`, `/api/ui/titulo`, `/api/clientes`,
  `/api/clientes/sync|contato|contato/renomear|contato/remover|lista|lista/remover|enviar|fila/limpar`;
  `iniciarClientesWorker()` no boot; card "👥 Clientes" (sync, cadastro, busca, seleção,
  listas, propaganda, fila) e links ✏️ renomear nos 4 cards. Lista usa `data-*` + event
  delegation para não repetir a armadilha do escape.

**Provas**:
- `/api/ui` devolve os 4 títulos; renomear "👥 Clientes (base)" persistiu e voltou no GET.
- Contato manual `5500000000001` criado; lista "Lista Teste" criada; disparo enfileirado
  (`pendentes:1`) e liberado no tick seguinte: `enviados:1`, `pendentes:0`,
  id `3EB0BD1B2CB98248841E6D` (mensagem enviada ao próprio número, teste seguro).
- Sync: 33/33 grupos, **1439 contatos** em 45s.
- `<script>` servido validado com `node --check` (pegadinha do `\n`/`\'` dentro do template
  literal corrigida antes do deploy).
- Monitor segue saudável (`autoEnviar:true`, `fila:0`); piloto religado (loop #2, 2/ciclo a 60s).

---

## 2026-10-19 | E6-UI-01 | Tema claro + 4 paletas no topo (redesign CSS)

**Pedido**: retrabalhar estilo da página — sair do modo escuro, usar círculo no topo para escolher
entre **verde, azul, laranja e vermelho**, montar paleta moderna e trabalhar grids/cards.

**Execução**: desenho do sistema visual com o agente `stylemaster` (nível ESSENCIAL/INTERMEDIÁRIO).
Na leitura do arquivo ele apontou um bug latente: `color:var(--mut)` no `#cuponsml` apontava para
variável inexistente — resolvido com alias `--mut` no `:root`.

**Entregue**:
- CSS todo reescrito em tema claro com tokens (`--surface`, `--border`, `--shadow-sm/md`,
  `--radius*`), `color-scheme:light` e fontes 100% system stack.
- **Semânticos separados da marca**: alertas (`pare/warn/ok`), status (`live/mock`) e preço
  (`.por`) têm tokens fixos — trocar a paleta não repinta um erro nem um aviso.
- 4 paletas via `[data-paleta]` no `<html>`: verde `#047857`, azul `#2563eb`, laranja `#c2410c`,
  vermelho `#d02626` — todas com branco a ≥5.1:1 (AA) e anel de foco próprio.
- `.paleta-bar` com 4 `.swatch` (<button> com `aria-label`/`aria-pressed`, anel + ✓ no ativo),
  script anti-flash no topo do body e persistência em `localStorage['paleta']` (`aplicar()`
  valida contra whitelist).
- Grids: `.grid2` empilha em ≤700px, `.grid4` vira 2 colunas, `.cards` em `minmax(260px)`;
  cards da vitrine com hover (sombra + `translateY`), `.noimg` com gradiente claro.
- Painéis com faixa de seção de 3px (`.ac-piloto`/`.ac-monitor`/`.ac-clientes`) substituindo os
  inline `border-color` escuros; títulos dos 4 cards viraram `.panel-head` com "✏️ renomear" à direita.
- Limpeza: 9 inline styles escuros em inputs/textarea removidos; `#1f2c33`→`var(--border)`,
  `#2a3942`→`var(--border-strong)`, `#f8806a`→`var(--danger-tx)`, links `#53bdeb`→`.lk-mini`;
  `prefers-reduced-motion` desliga transições.

**Provas** (prints locais, não publicados por conterem dados reais): `pal-verde/azul/laranja/vermelho.png`, `tema-mobile.png`
(390px) e `tema-live-completo.png` (página real em 8099 já populada pela API). Os 2 `<script>`
servidos passam em `node --check`; `data-paleta="verde"` + 4 swatches no HTML; zero cores escuras
residuais no fonte.

---

## 2026-10-19 | E6-UI-02 | Marca "Alcance" + paletas criativas de 3 cores (fundos tingidos)

**Pedido**: (1) renomear "autoMensagemWhats" para algo que se venda como produto; (2) refazer as
paletas como **combinação criativa de 2–3 cores derivadas** (verde/azul/laranja/vermelho) e
**não manter tudo em fundo branco**.

**Nome**: 6 candidatas de branding apresentadas (Propaga, Cascata, Radial, Loop, Alcance, +livre);
usuário escolheu **Alcance**. Aplicado em `<title>` ("Alcance — central de ofertas que se
espalham") e no cabeçalho: monograma "A" em bloco com gradiente + wordmark "Alcance" em
`background-clip:text` + tagline "capta · filtra · distribui — alcance é o que vende".
Zero ocorrências de "autoMensagemWhats" no HTML servido.

**Sistema cromático** (3 tokens por paleta: `--primary`, `--accent`, `--tertiary`):
- verde: esmeralda `#047857` + teal `#0f766e` + lima `#65a30d`;
- azul: royal `#2563eb` + violeta `#6d28d9` + ciano `#0891b2`;
- laranja: terracota `#c2410c` + âmbar `#b45309` + coral `#fb923c`;
- vermelho: carmim `#d02626` + rosa-forte `#be123c` + coral `#f97316`.
Fundos deixaram de ser brancos: `--bg`/`--bg-2` em gradiente tingido (`linear-gradient(168deg)`
fixo no body), superfícies `--surface`/`--surface-2` levemente tingidas, bordas e sombra
(`--shadow-tint`) na cor da paleta, `--code-bg` tingido.
Aplicações do trio: faixa do painel Piloto = grad-a→grad-b, Monitor = `--accent`→`--tertiary`,
Clientes = `--tertiary`→grad-b; CTAs em gradiente (`--grad-a`→`--grad-b`); toggles ON em
`accent`→`primary`; swatches mostram a combinação em gradiente de 135°.

**Contraste (WCAG, calculado)**: branco sobre grad-a/grad-b = verde 5.47/5.48 · azul 7.10/5.17 ·
laranja 5.02/5.18 · vermelho 6.29/5.27 (todos AA). Os `--tertiary` (2.26–3.68 vs branco) são
**exclusivamente decorativos** — nenhum texto sobre eles.

**Provas**: prints locais (não publicados) `top-{verde,azul,laranja,vermelho}.png` (cabeçalho + 1º painel de cada
paleta), `alcance-mobile.png` (420px) e `alcance-live.png` (página real em :8099). Scripts
servidos OK no `node --check`.

---

## 2026-10-19 | E6-AUDIT-01 | Auditoria de consistência do projeto (nota 6,5/10)

**Pedido**: avaliar a consistência geral do projeto e registrar o report.

**Escopo auditado**: `src/` (30 módulos, 6.374 LOC), `docs/` (12 docs + 4 ADRs + dev-log),
`data/` (18 arquivos de estado), git (branch/histórico/remoto/ignore), CI, compose/Dockerfile e
runtime (containers, endpoints, logs, webhook, dedup).

**Resultado**: relatório completo em **`docs/12-auditoria-consistencia.md`** —
nota geral **6,5/10**, com tabela por dimensão (arquitetura 7,0 · docs×entrega 5,0 · qualidade 6,5 ·
testes 1,0 · git 7,0 · operação 7,5 · segurança 7,0 · observabilidade 6,0).

**3 críticos (P0)**: container legado `automensagem_manager` operando a **mesma** `EVO_INSTANCE`
(`radar-piloto`) há 4 dias · **sem remoto git** (30+ commits só no disco) · **zero testes** apesar
de `npm test` existir. **Achados médios**: `data/` root-only, `server.ts` monolítico (914 das 1.660
linhas são a UI inline — origem dos 2 incidentes de escape), fila duplicada (`monitor/fila.ts` ×
`clientes/clientes.ts`), dedup sem poda por idade, CI testando o produto antigo, sem handlers de
erro/SIGTERM. **Baixos**: `pino` fantasma, 5 envs sem doc, resíduo `debug-webhook.log`, 1 ponto de
escape latente (linha 1128), API com `origens`/`destinos` como número vs `regras` como lista,
escopo duplo no repo (afiliado ML × Alcance).

**Sem alteração de código**: auditoria read-only; correções ficaram no plano P0/P1/P2 do doc.

---

## 2026-10-19 | E6-MONITOR-16 | Bug do grupo #55 (Epipe): links no domínio da origem + AMAZON_TAG

**Pedido**: usuário relatou que o grupo "#55 Emipe Promoções Tech" "não está reconhecendo" (modelo de captura).

**Diagnóstico (por evidências vivas)**:
- Regras do Emipe **ativas** (1º check leu o campo errado `r.ativo`; o certo é `r.origem.ativo` — todas as 6 regras OK).
- Mensagens **chegavam e desembrulhavam**: eventos tinham ENCAMINHADA (via `meli.la`) e DUPLICADO. O que falhava era
  `REVISAO "sem link de afiliado reconhecido"` (ex.: 19:36:37) para posts no domínio próprio
  `https://oferta.emipefps.com/amazon/XXXX` — host fora da allowlist do parser (RN-008).
- Captura ao vivo (proxy transparente em container na rede do compose, webhook temporariamente apontado para ele):
  a página do Epipe é um shell JS que resolve via `POST /api/public/abrir-link` →
  `{destino:"https://www.amazon.com.br/dp/ASIN?tag=emipefps0f-20"}`.
- 2ª causa: `AMAZON_TAG`/`SHOPEE_SUBID`/`KABUM_REF` **vazias** no `.env` → mesmo link Amazon reconhecido
  morria em `REVISAO "AMAZON_TAG não configurado"`.

**Correção**:
- **Novo `src/monitor/curtos.ts`**: `expandirLink()` — resolvedores de hosts de redirecionamento das origens
  (hoje `*.emipefps.com` via `/api/public/abrir-link`, timeout 8s, até 3 saltos). Host sem resolvedor → `null` sem rede.
- **`webhook.ts` passo 2.1**: sem link na allowlist, tenta expandir o 1º desconhecido → reclassifica → vira `principal`;
  `textoLimpo` recalculado (helper `limparTexto` extraído/exportado do `parser.ts`). Expansão falhou → REVISAO "sem link" como antes.
- **Painel de teste** (`/api/monitor/testar`): preview "principal" usa a mesma expansão.
- **`.env`**: `AMAZON_TAG=manodosachadi-20` (informada pelo usuário). Shopee/KaBuM seguem em revisão (usuário vai se inscrever).
- **Primeiros testes automatizados do repo** (`src/monitor/parser.test.ts`, node:test): 6 casos puros (allowlist,
  emipefps=desconhecido, detectar/limparTexto, extrairId ML/Amazon/Shopee) → `npm test` 6/6.

**Validação**:
- `expandirLink("https://oferta.emipefps.com/amazon/cpxhU6")` → URL final Amazon, ASIN B0DWGWN8GY ✓.
- Replay do caption real capturado em `/api/monitor/testar`: `ENCAMINHADO | Amazon`, link final com `tag=manodosachadi-20` ✓.
- Produção pós-deploy: **20:31:15 ENCAMINHADA amazon real** vinda do Emipe (B0HHNZFXL5, messageId real) ✓.
- Webhook da Evolution **restaurado** para `http://promo_radar_manager:8091/api/webhook/evolution`
  (confirmado em `/webhook/find`, enabled/base64/MESSAGES_UPSERT); container de captura `evo_captura` removido.

**Arquivos**: `src/monitor/curtos.ts` (novo) · `src/monitor/parser.ts` · `src/monitor/webhook.ts` ·
`src/manager/server.ts` · `src/monitor/parser.test.ts` (novo) · `.env` (não versionado).

**Pendências**: 1 REVISAO "sem link" do Emipe às 20:31:13 (2s antes de um forward OK — provável mensagem
não-oferta; watcher de 15s monitorando) · piloto com 0 loops (aguarda decisão do usuário) · tags Shopee/KaBuM.

---

## 2026-10-19 | E6-MONITOR-17 | Amazon: expansão de amzn.to + client Creators API (aguardando credenciais)

**Pedido**: usuário perguntou como os links Amazon são tratados com a tag dele e aprovou 2 itens:
(1) fechar o gap do `amzn.to`; (2) deixar o módulo da nova API Amazon pronto agora, com fallback total.

**Contexto (pesquisa oficial, out/2026)**: a **PA-API 5.0 foi descontinuada em 15/05/2026**; a substituta é a
**Creators API** (OAuth 2.0; sem AWS). Pré-requisitos: conta de associado com **aceitação final** e
**≥ 10 vendas qualificadas nos últimos 30 dias**; credenciais (Credential ID + Secret + Version) geradas em
Portal de Associados → Ferramentas → Creators API — confirmado nos portais US e BR. Brasil = região NA
(Version 3.1 → token em `api.amazon.com/auth/o2/token`; API em `creatorsapi.amazon`; marketplace
`www.amazon.com.br`).

**Como a comissão funciona (inalterado)**: o link de afiliado continua sendo gerado pela **troca de `tag`**
(`searchParams.set('tag', AMAZON_TAG)`) no transformer — a API nova é usada apenas para **enriquecer** o
repasse (título/foto oficiais), nunca para gerar link. Provas ao vivo do mecanismo: forwards de Amazon do
Epipe em 20:31:15, 20:38:19 e 20:57:08, todos com `tag=manodosachadi-20`.

**Correção do gap `amzn.to`**: encurtadores Amazon respondem 301/302 e **não repassam query params** — aplicar
`?tag=` direto neles perderia a comissão. Novo `expandirCurtoAmazon()` em `curtos.ts` resolve o redirect
(HEAD manual → GET follow como reserva, máx. 4 saltos) e o transformer aplica a tag no **link final**
`amazon.com.br/dp/...`. Falhou a expansão → mantém o comportamento anterior (não piora).

**Módulo novo `src/monitor/amazon-api.ts`** (Creators API):
- OAuth2 `client_credentials` (scope `creatorsapi::default`), endpoint de token pela Version da credencial
  (3.1 NA/BR default · 3.2 EU · 3.3 FE), **token cacheado** (renova 2 min antes de expirar).
- `GetItems` por ASIN (`itemInfo.title` + `images.primary.large/medium`), header `x-marketplace`.
- Retry único em 401/403 com token renovado; timeouts 8s/10s; **inerte sem credenciais** (zero rede).
- Preço não é buscado (o template usa `extrairPrecos` do texto da origem, igual ML); `offersV2` fica p/ futuro.

**Integração** (`transformer.ts` case amazon): expande curto → extrai ASIN pós-expansão → aplica tag →
enriquece via API (título/foto); falha/sem credencial → comportamento anterior; **nunca bloqueia**.

**Config**: `.env.example` e `.env` com `AMAZON_CREATORS_ID/SECRET` (vazias) + notas de
`AMAZON_CREATORS_VERSION`/`AMAZON_MARKETPLACE`. Quando as credenciais saírem: preencher o `.env` e
recriar o container — nada de código a mudar.

**Testes**: `amazon-api.test.ts` (4 casos: sem credencial=zero rede, fluxo feliz, cache do token, 401→renova)
+ `curtos.test.ts` (3: amzn.to 301, host direto, sem redirect) + helper `test-utils.ts`.
Repo agora com **13/13** passando (`npm test`).

**Validação**: typecheck + build + 13 testes OK; deploy + replay do caption real do Epipe →
`ENCAMINHADO | Amazon` com `tag=manodosachadi-20` (3,8s).

**Pendências**: credenciais Amazon (10 vendas/30d + aceitação final via portal); 1 REVISAO do Epipe em
observação; piloto com 0 loops; decisões da auditoria P0 (container legado/git remoto).

---

## 2026-10-20 | E6-MONITOR-18 | Amazon com foto JÁ (CDN por ASIN, sem depender da API)

**Pedido**: "preciso que as imagens dos links da Amazon apareçam" — não dava para esperar a liberação da
Creators API (10 vendas/30d).

**Solução**: imagem principal montada pelo padrão do CDN da Amazon a partir do ASIN —
`https://m.media-amazon.com/images/P/<ASIN>.01._SCLZZZZZZZ_SX500_.jpg` — sem API e sem scrape de página.
Validado ANTES de usar (HEAD, 5s; 2 padrões de sufixo; 404/timeout → segue sem foto, nunca quebra o envio).
Novo `resolverImagemAmazon()` em `amazon-api.ts`; no `transformer.ts` o enriquecimento vira em cascata:
**Creators API** (título+foto, quando liberada) → **CDN por ASIN** (foto; o texto da origem já traz o nome) →
sem nada (comportamento antigo).

**Evidência do padrão**: HEAD em 4/4 ASINs reais de hoje (`B0DWGWN8GY`, `B0HHNZFXL5`, `B0HHNVBHQ5`,
`B0CRMCC6W8`) → `200 image/jpeg` nos três sufixos testados.

**Testes**: +2 casos (`HEAD 200 → URL` / `404 nos dois padrões → null`); repo agora **15/15**.
Deploy + replay do caption real: `ENCAMINHADO | Amazon`, evento `teste (dryRun) · foto do anúncio` e payload
`[dry-run] ... imagem=https://m.media-amazon.com/images/P/B0DWGWN8GY.01._SCLZZZZZZZ_SX500_.jpg legenda=228chars`.
Falta apenas o post real do Epipe para confirmar visualmente no grupo (mesmo caminho de envio do dry-run).

**Ressalva**: ASIN com padrão de CDN diferente (raro) segue "sem foto" até a Creators API; detectável pelos
eventos (detalhe "sem foto"). Título na mensagem Amazon só com a API liberada.

---

## 2026-10-20 | E6-MONITOR-19 | Grupo destino: mensagens temporárias de 7 dias

**Pedido**: encaminhamentos "durarrem 5 dias no chat e depois serem deletados".
**Restrição do WhatsApp**: apagar-para-todos só funciona até ~2 dias e 12h após o envio (depois disso a
mensagem fica para sempre); mensagens temporárias só existem em 24h / 7 dias / 90 dias — **não há 5 dias**.
**Decisão do usuário**: ativar **temporárias de 7 dias** no grupo destino (some sem rastro, sem aviso de
"mensagem apagada").

**Execução** (sem mudança de código — configuração do grupo fica nos servidores do WhatsApp):
- Bot `radar-piloto` (`5500000000001`) é **superadmin** do grupo "Mano dos Achadinhos"
  (`120363000000000001@g.us`) — verificado via `findGroupInfos`.
- `POST /group/toggleEphemeral/radar-piloto` `{groupJid: "120363000000000001@g.us", expiration: 604800}`
  → `201 {"success":true}`.
- `findGroupInfos` desta versão da Evolution não expõe `ephemeralDuration` e a instância não guarda
  mensagens no banco (`DATABASE_SAVE_DATA_NEW_MESSAGE=false`) — confirmação visual no aparelho:
  grupo → info → "Mensagens temporárias: 7 dias".

**Efeito**: encaminhamentos (e demais mensagens) **enviados a partir de agora** somem após 7 dias para
todos; mensagens anteriores à ativação permanecem. Vale para todas as mensagens do grupo, inclusive de
membros. Para desligar: mesmo endpoint com `expiration: 0` (ou 86400 / 7776000 para 24h / 90 dias).

---

## 2026-10-20 | E6-MONITOR-20 | Envios indevidos ao grupo "Perfumes" — legado desligado (P0 fechado)

**Sintoma (usuário)**: mensagens chegando no grupo de teste "Perfumes" sem nenhuma configuração de envio
para ele no sistema novo.

**Investigação**: o sistema novo está limpo — `monitor.json` tem 6 regras de origem e **todas** apontam para
o único destino "Mano dos Achadinhos"; `piloto.json` do novo está com `loops: []`. A origem era o
**container legado `automensagem_manager`** (projeto `autoMensagemWhats`, porta 8091, up há 4 dias — P0 da
auditoria), que rodava um piloto próprio com **5 loops ativos** na conta "manodaspromo":
- 3 loops → `120363000000000003@g.us` = **Perfumes** (MLB6284 ×2 e MLB278194), envios a cada ~2min;
- 2 loops → `120363000000000004@g.us` (MLB1055, MLB3813).
Evidência: logs do container com `→ 120363000000000003@g.us` a cada poucos minutos (último envio 08:55).

**Ação**: `docker update --restart=no` + `docker stop automensagem_manager` → `Exited (137)`, sem restart
automático. Novo manager e as duas instâncias da Evolution (`radar-piloto`, `radar-mano-da-divulgacao-cfb`)
seguem `open` — sem impacto no monitor.

**Riscos residuais**: (1) o `data/piloto.json` do projeto antigo **preserva os 5 loops** — se alguém religar
o container, os envios voltam (recomendo limpar/arquivar o projeto antigo); (2) `data/contas.json` antigo
guarda cookies de sessão do ML em texto puro (P1 — rotacionar/limpar); (3) grupo
`120363000000000004@g.us` não aparece na lista das duas instâncias (é de outra conta) — os envios, porém,
partiam do piloto legado, agora parado.

---

## 2026-10-20 | E6-MONITOR-21 | Higiene do legado: loops zerados e cookies removidos

**Pedido**: resolver os 2 pontos de atenção do E6-MONITOR-20.

**1) Loops do piloto antigo** (`autoMensagemWhats/data/piloto.json`): `loops` 5 → **0** (histórico de logs
preservado). Mesmo que alguém rode `docker start automensagem_manager`, o piloto não tem mais o que enviar.
Container segue parado (`Exited 137`, `restart=no`); sem unit systemd e sem cron que o religue.

**2) Cookies de sessão do ML em texto puro**:
- `data/contas.json`: campo `cookie` zerado nas 3 contas (principal, superofertas, manodaspromo) — arquivo
  caiu de 11,8KB para 1,7KB; permissão `600`.
- `.env` antigo: `COOKIE_ML=` zerado; `.env` já era `600` e está no `.gitignore`.
- `data/` está no `.gitignore` e `git ls-files data/` não retorna nada → **cookies nunca foram versionados**.
- `GRUPO_TESTE` antigo = `120363000000000002@g.us` ("Radar Teste") — não era o Perfumes.

**Ação pendente do usuário (rotação)**: os cookies eram credenciais vivas de sessão do ML — recomendo entrar
nas 3 contas e encerrar todas as sessões (ou trocar a senha), para invalidar qualquer cópia que tenha
circulado. O sistema novo não usa esses cookies (usa link de afiliado + cupons).

---

## 2026-10-20 | E6-MONITOR-22 | UI: sidebar com links dinâmicos + views em dashboard

**Pedido**: cards identificados → sidebar lateral com links dinâmicos, ícones criativos e cada card com seu
conteúdo em formato de dashboard.

**Implementação** (`src/manager/server.ts`, HTML/CSS/JS inline):
- Shell `.app` = `<aside class="sidebar">` (258px, sticky, tema/status no rodapé) + `<main class="content">`
  com topbar (kicker/título/subtítulo por view + chip de status).
- 6 nav cards com **SVG inline** próprios: Contas (cartão), Cupons (ticket), Piloto (foguete), Monitor
  (radar), Números (celular + sinal), Clientes (pessoas); gradientes por card e badge numérico.
- **Hash routing**: `#/contas`, `#/cupons`, `#/piloto`, `#/monitor` (default), `#/numeros`, `#/clientes`;
  `hashchange` + `aria-current`, título do documento, scroll ao topo. Links são deep-linkáveis.
- **Views separadas**: Cupons saiu de Contas; Números saiu de Monitor. Todos os IDs e funções JS existentes
  foram preservados (nenhum endpoint alterado).
- **KPIs por view**: Monitor 8 (recebidas, encaminhadas, origens, destinos, duplicadas, revisão, erros,
  fila); Piloto 3 (loops, enviadas, último envio); Contas 2; Cupons 2 (registrados, cupons ML da categoria);
  Números 2 (números, conectados); Clientes 3 (contatos, listas, fila). Badges da sidebar atualizados nos
  loaders (`carregarContas`, `carregarCupons`, `atualizarPiloto`, `carregarMonitorStatus`,
  `carregarInstancias`, `carregarClientes`).
- **Responsivo**: ≤980px sidebar vira barra superior com nav horizontal; ≤700px ícones de 32px (os 6 cabem
  em 390px), KPIs auto-fit. Status online/offline no dot da sidebar + chip do topbar.

**Incidente de implementação**: o regex `/^#\/?/` do router foi interpolado pelo template literal TS e virou
`/^#/?/` no HTML → `SyntaxError` derrubava todo o script e todas as views ficavam `display:none`. Corrigido
com `split('/')` no hash (sem regex). Detecção: página servida com sidebar/topbar e conteúdo vazio.

**Validação**: `npm run typecheck` limpo; `npm run build`; `npm test` **15/15**; deploy
`promo_radar_manager` (8099→8091, HTTP 200). Playwright (Chromium 1248): default `#/monitor`; clique nos 6
links ativa a view certa, atualiza hash e título; badges `contas=1 cupons=0 piloto=0 monitor=1 numeros=2
clientes=6147`; KPIs monitor 157/70/6/6/53/26/0/0, cupons 0/6, clientes 6147/1/0; **sem erros JS**.
Screenshots desktop 1440×900 e mobile 390×844 conferidos. Obs.: screenshots headless às vezes saem com
"fantasma" (paint durante font swap) — HTML conferido (1 ocorrência por bloco) e `innerText` limpo, é
artefato de captura, não da UI.

**Pendências inalteradas**: credenciais Creators API (Amazon), `SHOPEE_SUBID`, rotação das sessões ML pelo
usuário, remote git (P0). Piloto segue com 0 loops (decisão do usuário).

---

## 2026-10-20 | E6-MONITOR-23 | UI: seletor de temas (verde/laranja + neutros elegantes)

**Pedido**: a seleção de cores sumiu na reformulação da sidebar; voltar o seletor, manter verde e laranja e
acrescentar variações de cinza escuro/marrom mais elegantes.

**Implementação** (`src/manager/server.ts`, HTML/CSS/JS inline):
- **6 temas** via `data-paleta` no `<html>`: `verde` (default), `laranja`, `areia` (taupe #8a6a4f),
  `grafite` (charcoal #44403c), `marrom` (coffee #7c4a2d) e `cacau` (chocolate #4a2c1d). Cada tema define
  `--primary/-hover/-soft/-border/-contrast`, `--ring`, `--grad-a/b`, `--accent/-soft`, `--info` e `--price`;
  blocos antigos `azul`/`vermelho` removidos.
- **Seletor no topbar** (`<details class="tema" id="temaBox">`): dot com amostra do gradiente, nome do tema,
  menu com 6 botões `.tema-opt[data-p]`, check no ativo e `aria-pressed`. Abre em qualquer view; fecha ao
  escolher, clicar fora ou `Esc`.
- **Persistência**: `localStorage['paleta']`; script inline no `<head>` aplica o tema antes do paint e valida
  a chave — valores legados (`azul`/`vermelho`) caem para `verde`.
- **Acabamento**: removidos `.paleta-bar`/`.swatch` do rodapé da sidebar; ícones dos nav cards deixaram de ter
  gradientes fixos coloridos e agora usam duotone do tema (`--primary-hover` sobre `--primary-soft`), com o
  card ativo em gradiente cheio. Harmonia mantida nos 6 temas.

**Validação**: `npm run typecheck` limpo; `npm run build`; `npm test` **15/15**; deploy
`promo_radar_manager` (8099→8091, HTTP 200). Playwright (Chromium 1248): os 6 temas aplicam
`data-paleta`/label/storage corretos; reload preserva a escolha (`cacau`); `azul` legado → `verde`; menu
mobile 390×844 abre alinhado à direita com as 6 opções. Screenshots dos 6 temas + mobile conferidos.

**Pendências inalteradas**: credenciais Creators API (Amazon), `SHOPEE_SUBID`, rotação das sessões ML pelo
usuário, remote git (P0). Piloto segue com 0 loops (decisão do usuário).

---

## 2026-10-20 | E6-MONITOR-24 | UI: fundo dos cards com a paleta do tema

**Pedido**: as variações de tema ficaram boas, mas trabalhar a paleta também nos **backgrounds dos cards**
(antes quase brancos, destoando do fundo tingido).

**Implementação** (`src/manager/server.ts`):
- Nova camada de cor por tema: `--card` (superfície do card) e `--card-2` (caixas aninhadas/hover), com tom
  tirado da própria paleta em vez do branco:
  - verde `#f2faf6`/`#e3f1e9`; areia `#f9f2e9`/`#efe3d4`; grafite `#f8f5f2`/`#ece7e2`;
    laranja `#fff8f0`/`#fbe8d6`; marrom `#fcf4ec`/`#f2e4d6`; cacau `#faf2e9`/`#f0e1d2`.
- Aplicado em `.panel`, `.kpi`, `.card` (ofertas), `.regra`, `.tema summary`/`.tema-menu` e no degradê da
  sidebar; caixas internas (`.mbox`, `.mrow`, `.regra.off`) usam `--card-2`. Inputs/selects seguem em
  `--surface` (mais claros) para manter hierarquia de formulário.
- Cards deixam de ser brancos e passam a "pertencer" ao tema, mantendo contraste de texto e sombras.

**Validação**: `typecheck`/`build` limpos, `npm test` **15/15**, deploy `promo_radar_manager` (8099→8091,
HTTP 200). Playwright nos 6 temas: aplicação/persistência ok; screenshots conferidos em verde, laranja,
areia, grafite, marrom e cacau — cards tingidos, caixas internas com um tom abaixo e sidebar em degradê.

**Pendências inalteradas**: credenciais Creators API (Amazon), `SHOPEE_SUBID`, rotação das sessões ML pelo
usuário, remote git (P0). Piloto segue com 0 loops (decisão do usuário).

---

## 2026-10-20 | E6-AUTH-01 | Protótipos de login (3 opções) + spec de segurança

**Pedido**: implementar tela de autenticação com animação; antes da implantação, entregar **3 protótipos
navegáveis** para avaliação.

**Consultas a agentes**:
- **aprendiz**: base do projeto vazia; lições visuais do ecommerce e de segurança do `promo-radar-saas`.
  Alertas: proto-first; `prefers-reduced-motion` obrigatório; glassy/blur custa GPU no mobile; sem som;
  auth hardening (rate-limit/lockout, fail-closed, timing-safe) e armadilha de `await` em handler não-async.
- **kalimaster**: requisitos MUST para a implementação — scrypt assíncrono + `timingSafeEqual`, cookie
  `HttpOnly/SameSite`, TTL/idle/rotação, Origin/CSRF, rate-limit, default-deny em GETs, headers, auditoria
  sem PII, TLS em LAN; apontou 15 riscos do `MANAGER_KEY` atual (GETs abertos, chave em `sessionStorage`,
  fail-open, comparação `!==`, sem logout/TTL).
- **protomaster**: construiu os 3 protótipos autocontidos, sem CDN/build.

**Entregas**:
- `docs/prototipos/auth/index.html` — hub comparativo com previews e roteiro de teste.
- `opcao-1.html` — **Sala de controle** (split-screen, orbs, stagger, selo de sucesso).
- `opcao-2.html` — **Esteira de ofertas** (marquee diagonal, cartão translúcido, parallax, wipe).
- `opcao-3.html` — **Radar** (tema escuro, sweep, blips, inputs underline, ripple).
- `README.md` — como abrir, prós/contras, critérios e limitações.
- `docs/13-auth-spec.md` — escopo, rotas, checklist de segurança, critérios de aceite Gherkin, riscos e
  decisões abertas.

**Validação**: servidor local em `http://localhost:8100/` (HTTP 200); Playwright 1440×900 e 390×844 —
login demo `admin`/`alcance` chega ao painel simulado, senha errada exibe erro com shake, toggle de senha,
paletas, "Sair" e `prefers-reduced-motion`; `scrollWidth=390` sem overflow; **0 erros JS**.

**Próximo passo**: usuário escolhe a opção (1, 2 ou 3) e responde às decisões abertas da spec; só então
implementar backend de sessão + tela escolhida.

**Pendências inalteradas**: credenciais Creators API, `SHOPEE_SUBID`, rotação das sessões ML, remote git
(P0), piloto com 0 loops (decisão do usuário).

---

## 2026-10-20 | E6-AUTH-02 | Login real + gate default-deny + sessão

**Pedido**: implementar a autenticação com a **opção 1 — Sala de controle** aprovada. Acesso ainda indefinido
(“Ainda não sei”): subir em **HTTP local** agora e tratar TLS/reverse proxy como etapa separada antes de LAN.

**Decisões**: single `admin`; sessão **8h absoluta + 30min idle**; `MANAGER_KEY` mantida só como credencial
machine para `/api/*`; 6 paletas compartilhando a chave `paleta`; senha em `data/auth-users.json` (0600) via
CLI, nunca no `.env`.

**Implementação**:
- `src/manager/auth.ts`: scrypt assíncrono (`N=2^15,r=8,p=1`, salt 16B), `timingSafeEqual` sobre SHA-256,
  hash dummy para usuário inexistente, limite de 4 hashes concorrentes; sessão `sid` 32B + HMAC-SHA256,
  store em memória com TTL absoluto/idle, limite de 5 sessões, sweeper; cookie `alcance_sid`
  (`HttpOnly; SameSite=Strict; Path=/`), rate-limit 5/min por IP + 30/min global, auditoria JSONL com IP /24.
- `src/manager/server.ts`: `GET /login`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`;
  **default-deny** em `GET /` e `/api/*`; webhook isento com `WEBHOOK_KEY`; headers CSP/COOP/CORP/nosniff/
  frame-deny/no-store; Origin + `Sec-Fetch-Site`; body limit; `MANAGER_KEY` só machine e timing-safe.
- `src/manager/login.html`: opção 1 adaptada (6 paletas, sem dica de demo), erro/loading/selo, `fetch` real,
  `prefers-reduced-motion`; painel ganhou botão **Sair** e perdeu o `sessionStorage['mkey']`.
- `scripts/auth-user.mjs` + `npm run auth:user`: cria/atualiza credencial com prompt oculto ou `AUTH_PASSWORD`.
- `.env`: `SESSION_SECRET`, `AUTH_TTL_HORAS=8`, `AUTH_IDLE_MIN=30`, `AUTH_COOKIE_SECURE=0`.
- `docker-compose.manager-novo.yml`: porta publicada em **`127.0.0.1:8099`** até o TLS.

**Validação**: `typecheck`/`build` limpos; `npm test` **22/22** (7 novos de auth); curl no container:
`GET /` 302→`/login`, `/api/*` 401 sem sessão, login 200 + cookie, `/api/contas` 200 com sessão, logout 200,
401 após logout, webhook 200 com chave, 6ª tentativa errada 429 + `Retry-After`; Playwright 1440×900 e
390×844: login/erro/sucesso/selo/painel/Sair, 6 paletas, `scrollWidth=390`, **0 erros JS** (favicon incluído).
Deploy `promo_radar_manager` recriado; `ss` confirma `127.0.0.1:8099`.

**Credencial**: admin criado com senha temporária entregue no chat; trocar com
`AUTH_PASSWORD='...' npm run auth:user -- admin` e reiniciar o manager. Sessões são em memória (restart
desloga todos).

**Pendências**: TLS/reverse proxy antes de LAN; container non-root; retenção/rotação do `auth-audit.log`;
rate-limit do webhook; refatorar `onclick` inline para CSP sem `unsafe-inline`; credenciais Creators API,
`SHOPEE_SUBID`, rotação das sessões ML, remote git (P0), piloto com 0 loops.

---

## 2026-10-21 | E6-REL-01 | Relatório geral, CI com testes + smoke e publicação pública

**Pedido**: report completo do projeto; depois executar os 3 itens sugeridos (salvar report, fechar P0 de
remote/CI e abrir o plano de sincronização documental), criando repositório público no GitHub.

**Entregas**:
- `docs/14-relatorio-geral.md` — retrato do estado real (nota 7,5/10), arquitetura, runtime, dados,
  qualidade, segurança, riscos P0/P1/P2 e pendências do usuário.
- `docs/15-plano-sincronizacao-docs.md` — plano de SRS v0.4 (RF-040..RF-047, NFR-009..NFR-013),
  backlog v0.4 (E7–E10, US-21..US-32), ADRs 005–008 e reescrita de README/CHANGELOG.
- `scripts/smoke-manager.sh` + `npm run smoke:manager` — sobe o manager com `ALCANCE_DATA_DIR` temporário,
  `ALCANCE_SMOKE=1` (sem workers) e valida `/login` 200, `/` 302, `/api/contas` 401, webhook 401 e 404.
- `src/manager/server.ts` e `scripts/auth-user.mjs` — suporte a `ALCANCE_DATA_DIR`; `ALCANCE_SMOKE`
  desativa os workers de fila no smoke.
- `.github/workflows/ci.yml` — passou a rodar `npm test`, `npm run smoke:manager` e o smoke do CLI;
  inclui `master` e `permissions: contents: read`.
- `README.md` — reescrito para a marca **Alcance**, porta 8099, auth, monitor, clientes, multi-número,
  testes e aviso de TLS.

**Validação**: `typecheck`/`build` limpos; `npm test` 22/22; `npm run smoke:manager` OK;
`git status` limpo antes da publicação.

**Publicação**: repositório público `Regimarcilio/alcance-promo-radar`. Antes do push, o histórico foi
sanitizado com `git filter-repo`: telefones, JIDs e convite do WhatsApp substituídos por placeholders e
`docs/prints/` (capturas com dados reais) removida do histórico. Backup do histórico original em bundle
local fora do repositório.

**Pendências inalteradas**: TLS/reverse proxy, container non-root + ownership de `data/`, poda do dedup,
extração da UI de `server.ts`, handlers globais de erro, credenciais Creators API, `SHOPEE_SUBID`,
rotação das sessões ML, piloto com 0 loops.


---

## 2026-10-21 | E6-SHOPEE-01 | Link de afiliado Shopee via Open API

**Pedido**: entender como o link de afiliado aparece no painel Shopee e corrigir a lacuna do monitor.

**Diagnóstico**: o case `shopee` do `transformer.ts` anexava `smtt` e devolvia `ok:true`. `smtt` é
rastreio do app, não atribuição de afiliado; o link saía sem comissão e pulava a revisão (RN-012).

**Entregas**:
- Issue #8 com contrato da API, variáveis, AC Gherkin e bloqueio de credenciais.
- `src/monitor/shopee-api.ts` — `generateShortLink` na Open API, assinatura SHA-256
  (`AppId+Timestamp+Payload+Secret`), timeout 8s, cache 6h e validação de domínio do shortLink.
- `src/monitor/transformer.ts` — Shopee agora usa o shortLink; sem credenciais ou em falha mantém o
  original e manda para revisão. `SHOPEE_SUBID` legado aplica `smtt`, mas com `ok:false`.
- Testes: `shopee-api.test.ts` e `transformer.test.ts` (fetch mockado, sem rede).
- `.env.example`, README, SRS (RF-032), US-18, relatório 14 e ADR-009 atualizados.

**Validação**: `typecheck`/`build` limpos; `npm test` 37/37; `npm run smoke:manager` OK.

**Pendência**: App ID/Secret da Shopee (`affiliate.shopee.com.br/open_api`, até ~2 semanas) para validar
o fluxo live; até lá, o módulo fica inerte e links Shopee vão para revisão.

---

## 2026-10-21 | E6-CLI-01 | Limite de eventos configurável, filtro por grupo e "adicionar ao grupo"

**Pedido**: contador do monitor travava em 500 mensagens; filtro por grupo na aba Clientes; ação
"adicionar ao grupo" ao selecionar contatos.

**Entregas**:
- `src/monitor/state.ts` — `LIMITE_EVENTOS` vem de `MONITOR_EVENTOS_LIMITE` (padrão 500, `0` = ilimitado).
  Era a causa do contador travado: `s.eventos.slice(-500)` truncava o array e `resumo().recebidas`
  é o tamanho dele.
- `src/manager/server.ts` — dropdown "👥 Todos os grupos" na aba Clientes (filtra por `origem` do
  contato) e caixa "➕ Adicionar selecionados ao grupo" (aparece quando há seleção, com os grupos
  pareados vindos de `/api/grupos`).
- `POST /api/clientes/grupo` — novo endpoint: resolve os JIDs em telefones e chama a Evolution.
- `src/monitor/evolution.ts` — `adicionarParticipantes()` usa `POST /group/updateParticipant/{inst}`
  com `action: "add"` e participantes no formato `+código` (Evolution v2.3.7).
- `ALCANCE_DATA_DIR` agora é respeitado por **todos** os módulos de estado (antes só o manager e o
  `auth-user.mjs` usavam) — o smoke/teste não encostava mais no `data/` real. Bug encontrado durante
  a validação: `src/clientes/clientes.ts` lia o diretório real mesmo com a env setada.
- Testes: `src/monitor/state.test.ts` (limite 3 / 0 / padrão) e `src/monitor/evolution.test.ts`
  (normalização de números, grupo inválido, erro 403).

**Validação**: `typecheck`/`build` limpos; `npm test` 44/44; `npm run smoke:manager` OK; fluxo real
validado via HTTP (login → `/api/clientes/grupo` → Evolution `updateParticipant` com
`{"action":"add","participants":["+5511999990001","+5511999990002"]}`), com mock da Evolution.

**Limite do WhatsApp**: adicionar participante só funciona se a conta pareada for ADMIN do grupo e
o grupo tiver o link de convite habilitado; fora disso a API devolve erro, que a UI mostra em
`cliaddmsg` sem quebrar a tela.

---

## 2026-10-21 | E6-CLI-02 | Corrige painel quebrado por escape em template literal

**Sintoma**: na aba Clientes, o dropdown de grupos não populava e a caixa "➕ Adicionar selecionados
ao grupo" não aparecia ao marcar contatos. O painel inteiro estava sem JS.

**Causa raiz**: o HTML do painel é um template literal do TypeScript (`const PAGINA = \`...\``). No
`confirm()` novo eu escrevi `\n\n` (escape simples) — o TypeScript converte para quebras de linha
REAIS no HTML servido, o que fecha a string JS no meio e derruba **todo** o `<script>` do painel com
`SyntaxError: Invalid or unexpected token`. O projeto usava `\\n` (escape duplo) nos outros pontos.

**Correções**:
- `src/manager/server.ts` — `\n\n` → `\\n\\n` no `confirm()`.
- `atualizarCaixaAdicionar()` não apaga mais a mensagem de sucesso (a seleção é zerada logo após
  adicionar, o que apagava o "N adicionado(s) ✓").
- `src/manager/pagina.test.ts` — teste de regressão: renderiza o template e valida a sintaxe de cada
  bloco `<script>` (com `new Function`, que só parseia) + caça escapes simples no literal. Verificado
  que o teste FALHA com o código quebrado e PASSA com o corrigido.

**Validação**: `typecheck`/`build` limpos; `npm test` 47/47; `npm run smoke:manager` OK; E2E em
navegador (Playwright/Chromium) contra a build nova: filtro por grupo (4→2→1 contato), caixa aparece
ao selecionar (`display:none`→`flex`), grupos carregados, Evolution chamada com
`{"action":"add","participants":["+5511999990001"]}` e mensagem "1 adicionado(s) ✓"; zero erros JS.

**Deploy**: o container `promo_radar_manager` (compose `docker-compose.manager-novo.yml`, porta 8099)
rodava a imagem `promo-radar-manager:latest` de 20/out — build sem os recursos. Imagem reconstruída
e container recriado para passar a servir a UI nova.

---

## 2026-10-21 | E6-PERM-01 | Permissões de grupo (somente admins falam/comentam)

**Pedido**: bloquear comentários/mensagens dos participantes no grupo "Mano dos Achadinhos" — somente
administradores podem falar.

**Implementação**:
- `src/monitor/evolution.ts` — `buscarPermissaoGrupo()` (GET `/group/findGroupInfos`) e
  `definirPermissaoGrupo()` (POST `/group/updateSetting` com `announcement` / `not_announcement` /
  `locked` / `unlocked`).
- `src/manager/server.ts` — `GET`/`POST /api/grupos/permissao` + bloco "🔒 Permissões do grupo" na
  aba Monitor (escolher grupo + 4 ações: só admins falam / todos falam / só admins editam / todos editam).
- Testes: 4 novos em `src/monitor/evolution.test.ts` (51/47 no total).

**Aplicado em produção**: grupo `120363412937047408@g.us` ("Mano dos Achadinhos", 5 participantes)
passou de `announce:false` para `announce:true` (HTTP 201 na Evolution, confirmado via
`findGroupInfos`). `restrict` ficou `false` — só admins editam nome/avatar é outro ajuste, disponível
no botão "🛡 Só admins editam" caso o usuário queira.

---

## 2026-10-21 | E6-SYNC-01 | Sync de contatos volta a puxar todos os grupos

**Sintoma**: "parou de carregar os contatos de todos os grupos". Último sync bem-sucedido: 19/out.
Log da Evolution: **1.794 erros `rate-overlimit`** (HTTP 500 do Evolution, 429 do WhatsApp via Baileys
na `groupMetadata`) e 1,17 milhão de linhas de log.

**Causa raiz**: `sincronizar()` disparava uma consulta de participantes por grupo **sem pausa**.
Cada consulta vira uma `groupMetadata` no WhatsApp; 32 grupos em rajada estouram o rate limit e o
sync terminava quase sem capturar nada — e o erro era engolido em `catch {}` (sem nenhuma visibilidade
na UI).

**Correções**:
- `src/clientes/clientes.ts` — pausa entre grupos (`SYNC_PAUSA_MS`, padrão 4s), backoff + 1 retry
  quando o WhatsApp limita (`SYNC_BACKOFF_MS`, padrão 45s), 403 (grupo sem permissão) não conta como
  erro, e `estadoSync()` passou a expor `erros` e `ultimoErro`.
- `src/manager/server.ts` — a linha de status da aba Clientes mostra o progresso e os erros
  ("⚠️ N grupo(s) falharam: …"), e o botão de sync avisa que leva alguns minutos.
- `.env.example` — `SYNC_PAUSA_MS` e `SYNC_BACKOFF_MS`.
- `src/clientes/clientes.test.ts` — 4 testes: importa de todos os grupos, erro de rate limit conta e
  não trava o sync, 403 não conta como erro, retry no mesmo grupo.

**Validação**: `typecheck`/`build` limpos; `npm test` 55/55; `npm run smoke:manager` OK.

---

## 2026-10-21 | E6-MON-01 | Aba Monitor: grupos param de carregar (cache de fallback)

**Sintoma (corrigido)**: "os grupos não estão sendo carregados na aba monitor".

**Diagnóstico**: os selects Origem/Destino da aba Monitor vêm de `GET /api/monitor/whats-grupos` →
Evolution `GET /group/fetchAllGroups`. Esse endpoint está sujeito ao **rate limit do WhatsApp**
(429 rate-overlimit → HTTP 500 na Evolution) e é lento (9-20s). Quando o WhatsApp limita, a rota
devia `grupos: []` e a aba ficava **sem nenhum grupo**, sem explicar por quê.

**Correções**:
- `src/monitor/evolution.ts` — a última lista boa é gravada em `data/grupos-cache.json`
  (`gruposDoCache()`), e `listarGrupos()` passa a persistir todo sucesso.
- `src/manager/server.ts` — `/api/monitor/whats-grupos` e `/api/grupos` caem para o cache salvo
  quando a Evolution falha, devolvendo `deCache: true` + `aviso` explicativo; a UI mostra
  "(lista salva — Evolution limitada)".
- `src/manager/server.ts` (UI) — a mensagem de carregamento avisa que leva 10-30s e que, se o
  WhatsApp limitar, a última lista salva será usada.
- `src/clientes/clientes.ts` — ritmo do sync mais conservative: `SYNC_PAUSA_MS` 4s → **8s** e
  `SYNC_BACKOFF_MS` 45s → **90s** (o sync de 32 grupos era o que saturava a conta).
- Teste: cache de grupos sobrevive à falha da Evolution (`evolution.test.ts`).

**Validação**: `typecheck`/`build` limpos; `npm test` 56/56; `npm run smoke:manager` OK;
`fetchAllGroups` confirmado em produção (HTTP 200, 32 grupos, 20s).

---

## 2026-10-21 | E6-AMZ-01 | Piloto Amazon (mesmo modelo do ML) + aba Rastreio

**Pedido**: usar o modelo da aba Piloto para categorias da Amazon, e saber se é possível rastrear.

**Resposta**: sim — a Creators API (já integrada para título/foto) tem `SearchItems` (busca por
palavra-chave e `browseNodeId`) e `GetBrowseNodes` (árvore de categorias), o mesmo formato do
`hunt()` do Mercado Livre. O rastreio é pela **tracking ID** (`tag`): o link publicado já vai com a
tag, que é o que credita a comissão no painel da Amazon.

**Entregas**:
- `src/amazon/categorias.json` — 16 categorias Amazon (id AMxxx + nome + palavras de busca).
- `src/amazon/amazon.ts` — categorias, `linkAfiliadoAmazon()` (URL com `?tag=`), `tagAmazon()`
  (tag por categoria: `AMAZON_TAG_AMXXX` > `AMAZON_TAG`) e rotação de palavras por giro.
- `src/monitor/amazon-api.ts` — `buscarOfertasAmazon()` (SearchItems da Creators API) e
  `listarBrowseNodes()`; parser tolerante a casing (PascalCase/camelCase).
- `src/ml/piloto.ts` — `PilotoCfg.programa` (ml|amazon): caça Amazon → mesmo `Candidato`/scorer/
  formatter; link com tag; sem tag não publica (não paga comissão); cupom ML ignorado.
- `src/store/publicacoes.ts` — log de publicações (Piloto + Monitor) com filtros, resumo e CSV.
- `src/manager/server.ts` — aba **🎯 Rastreio** (KPIs, filtros por programa/via/período, export CSV),
  seletor de programa no Piloto, `/api/categorias?programa=amazon`, `/api/rastreio`, `/api/amazon/status`.

**Estado (honesto)**: `AMAZON_TAG` está configurado (link e rastreio já funcionam), mas
**faltam `AMAZON_CREATORS_ID`/`SECRET`** — sem eles a caça Amazon fica inerte e o loop aguarda
(nunca posta oferta inventada). Solicitar em: Portal de Associados → Ferramentas → Creators API.

**Validação**: `typecheck`/`build` limpos; `npm test` 65/65 (9 novos: categorias, link, tag,
keywords, publicações, filtros, resumo, CSV); E2E no navegador: Rastreio com 3 publicações
(1 ML, 2 Amazon, 2 com tag), filtros por programa e por via, CSV com BOM, 16 categorias no select
do Piloto, aviso de credenciais ausente — **zero erros JS**.

---

## 2026-10-21 | E6-PIL-01 | Envio parado: loops do Piloto pausados no reinício

**Sintoma**: "agora parou o sistema de envio de mensagens".

**Diagnóstico (por camadas)**:
1. Envio na Evolution: **OK** (texto e mídia, HTTP 201) — o `sendMedia 500` era transitório.
2. Monitor: **OK** — 6 regras ativas, `autoEnviar=true`, eventos ENCAMINHADA chegando.
3. Piloto: **PARADO** — `data/piloto.json` sem nenhum loop. No log:
   `16:16 ☕ pausa de 8 min` → `16:23 ⏸ 1 loop(s) pausado(s) após reinício` → `16:37 #2 START
   programa=amazon` → `caça AMAZON indisponível (credencial ausente)` → `16:46 #2 e #1 parados`.

**Causa raiz**: o Piloto **pausa todos os loops no boot** (segurança: `rodando:false` + persiste a
pausa). Como o deploy reinicia o container, toda atualização parava a publicação e exigia clique manual
em ▶ START. Além disso, o loop Amazon que o usuário ligou às 16:37 não tinha credenciais da Creators
API, então ele não tinha nada a postar (comportamento correto: nunca posta oferta inventada).

**Correções**:
- `PILOTO_AUTORELIGA=1` (novo, **opt-in**): retoma os loops que estavam rodando após o reinício.
  Padrão segue sendo pausar tudo por segurança.
- Aba Piloto: aviso claro "⏸ N loop(s) parados — nada está sendo publicado por eles", com o caminho
  para religar (e a dica da env).
- `src/ml/piloto.test.ts` — 2 testes: com a env, o loop religa; sem ela, pausa e persiste a pausa.

**Estado**: loop ML religado com a mesma config do log (conta=principal, MLB1246/MLB6284,
grupo 120363411920451567@g.us, 1x/5min, 90s) →-publicação confirmada às 16:50 com foto.

**Correção adicional (achada na validação)**: o store do Piloto é **lazy** — os timers só eram
agendados quando alguém chamava algo do módulo (tipicamente o navegador aberto). Sem navegador, o
Piloto ficava muda mesmo com a grade "ligada". Agora o manager chama `retomarLoopsNoBoot()` no boot
(`server.listen`), que carrega o store e agenda os timers. Log: `piloto: N loop(s) religados no boot`.

**Validação final**: deploy → boot → `▶ 1 loop(s) religados automaticamente` → publicação às 17:14
(com foto). `npm test` 67/67; smoke OK.

---

## 2026-10-21 | E6-VOL-01 | Variação de números + volume coerente com o recebido

**Relato**: "não está variando o envio entre os números cadastrados" e "não está enviando a quantidade
de mensagens consistente com a recebida dos outros grupos".

**Diagnóstico (dados dos últimos 500 eventos)**:
- ENCAMINHADA 179 · DUPLICADO 229 (46%) · REVISAO 85 (47 Shopee sem credencial + 37 link não
  reconhecido) · ENFILEIRADA 7 → só **36%** das ofertas recebidas chegaram ao grupo.
- Rotação: os DOIS números enviam (radar-piloto 739 envios, radar-mano-da-divulgacao 465, ambos
  `open`), mas o sorteio é puro: pode dar 2 envios seguidos do mesmo celular — e é isso que o
  operador enxerga como "não está variando".

**Correções**:
- `src/wa/rotacao.ts` — anti-repetição **probabilística** (padrão 70%, env `RODIZIO_EVITA_REPETICAO`):
  evita repetir o número do envio anterior quando há outro conectado, sem anular o peso por número
  (com pesos iguais a variação fica ~85%; com peso muito diferente o número "quente" ainda lidera).
  `ultimaInstanciaUsada()` expõe a última escolha.
- `src/monitor/state.ts` — dedup com janela configurável (`DEDUP_DIAS`, padrão 7) e escopo
  (`DEDUP_POR_ORIGEM=1` → o mesmo produto de origens diferentes é reencaminhado, multiplicando o
  volume sem repetir dentro da mesma origem).
- `src/monitor/webhook.ts` — a origem entra no hash do dedup quando o escopo é "por origem"; e o
  motivo da revisão agora traz **os domínios não reconhecidos** (antes só dizia "link não
  reconhecido", sem dizer o que faltava na allowlist).
- `src/manager/server.ts` — aba Monitor ganha o quadro **"📊 Volume"**: % encaminhada, recebidas →
  encaminhadas, duplicadas, revisão e o modo de dedup em uso.
- `.env.example` — `DEDUP_DIAS`, `DEDUP_POR_ORIGEM`, `RODIZIO_EVITA_REPETICAO`.

**Validação**: `typecheck`/`build` limpos; `npm test` **73/73** (6 novos: rotação com/sem
anti-repetição, última usada, dedup por origem, dedup global, janela em dias); smoke OK.

**Achado do diagnóstico de volume**: com o dedup por origem a taxa de encaminhamento subiu de
**36% → 50%** nos últimos 80 eventos. O motivo das revisões ficou visível: `tidd.ly` (encurtador) —
os grupos postam link curto, que o parser não reconhece. Adicionado **resolvedor de encurtadores**
(`src/monitor/curtos.ts`): segue 1 redirect de hosts conhecidos (tidd.ly, bit.ly, cutt.ly,
encurtador.com.br, linkr.com.br, meulink.com.br, is.gd, tinyurl, vk.cc, rebrand.ly, short.gy,
shrinkme, clck.ru, 0x0.st, lnkd.in, t.co…) e reclassifica o destino.

**Medição**: último bloco de 80 eventos após `DEDUP_POR_ORIGEM=1`: ENCAMINHADA 40 · DUPLICADO 33 ·
REVISÃO 7 → **50%** encaminhada (antes 36%).

---

## 2026-10-21 | E6-SEC-01 | Verificação de celular no 1º acesso + favoritos do ML

**Pedidos**: (1) camada de segurança no login — além de usuário e senha, exigir **WhatsApp válido**
no cadastro e enviar um **código alfanumérico de 10 posições** para o celular, usado no primeiro
acesso; (2) salvar automaticamente cada oferta enviada nos **favoritos do Mercado Livre**, para o
cliente navegar outras opções.

**Entregas**:
- `src/manager/verificacao.ts` — código de 10 posições (alfabeto sem 0/O e 1/I), SHA-256 com sal do
  usuário (o texto puro **nunca** é gravado), validade 10 min, trava após 5 tentativas, comparação
  em tempo constante; envio por WhatsApp via Evolution; código puro em memória só para *reenviar o
  mesmo*; máscara do telefone (`55•••9999`).
- `scripts/auth-user.mjs` — exige `--telefone 5511999999999` (ou `AUTH_TELEFONE`), valida o número,
  envia o código no cadastro e grava a verificação pendente.
- `src/manager/server.ts` + `src/manager/login.html` — `POST /api/auth/login` passa a pedir o código
  quando o celular não foi confirmado (`precisaCodigo` + telefone mascarado);
  `POST /api/auth/reenviar-codigo`; tela de login com campo de código (10 posições) e aviso do
  telefone mascarado.
- `src/ml/favoritos.ts` — `POST /users/me/bookmarks` (item_id) com `ML_ACCESS_TOKEN`; inerte sem
  token; erro nunca impede a publicação. Ligado ao fluxo do Piloto (com log `⭐`).

**Verificação da viabilidade dos favoritos (docs oficiais do ML)**: a API existe
(`POST /users/me/bookmarks`, `GET`, `DELETE`), mas **(a)** exige **access token OAuth** — o projeto
usa TAG + COOKIE, que não autenticam essa API; e **(b)** os favoritos são **da conta do afiliado**:
o cliente final **não** vê a sua lista ao clicar no link (ele vê a vitrine do vendedor de cada
oferta, que o ML já oferece nativamente). Ou seja: a implementação fica pronta, mas o objetivo
original ("o cliente navegar outras opções") tem um caminho melhor — divulgar a vitrine do
**próprio** vendedor. Isso está registrado na ADR-010.

**Compatibilidade**: usuário **sem** celular cadastrado continua entrando só com usuário e senha —
nenhum acesso existente quebra.

**Validação**: `typecheck`/`build` limpos; `npm test` **88/88** (13 novos: 8 de verificação, 5 de
favoritos); smoke OK; E2E no navegador com Evolution mock: código enviado no WhatsApp → campo
aparece com telefone mascarado → **código certo entra no painel** → código errado devolve
"código inválido" → zero erros JS.

---

## 2026-10-21 | E6-GRUPO-01 | Adição de contatos ao grupo: rate-overlimit do WhatsApp

**Sintoma**: ao adicionar contatos ao grupo, erro `Evolution 400: {"message":["Error updating
participants","Error: rate-overlimit"]}`.

**Diagnóstico**: os 38 erros de rate-limit em 5 min no log da Evolution vêm de
`updateGroupMetadataCache` — o **job de fundo da própria Evolution**, que atualiza os metadados dos
32 grupos da conta de uma vez e estoura o limite do WhatsApp. A adição de participante usa a mesma
via (groupMetadata) e cai na mesma janela. Medido: uma adição pode levar **até 60s** quando a conta
está limitada (e voltando com `updateParticipants: []`).

**Correções**:
- `src/monitor/evolution.ts` — `adicionarUmParticipante()`: UM participante por chamada, com retry e
  espera maior quando vier rate-overlimit; interpreta o `updateParticipants[]` (409 = já estava no
  grupo = sucesso).
- `src/monitor/grupo-add.ts` (novo) — **job em background**: a adição é feita em gotejamento (pausa
  entre contatos) e a UI acompanha o progresso. Antes, a tela ficava pendurada por minutos
  (cada adição pode levar 60s).
- `src/manager/server.ts` — `POST /api/clientes/grupo` inicia o job e responde na hora;
  `GET /api/clientes/grupo/status` traz o progresso (feitos/total/adicionados/jaNoGrupo/falhos).
  A UI mostra "adicionando… 3/12 · 2 no grupo" e explica o rate limit.
- `.env.example` — `GRUPO_ADICIONAR_PAUSA_MS` (3s), `GRUPO_ADICIONAR_ESPERA_MS` (45s),
  `GRUPO_ADICIONAR_TENTATIVAS` (3).

**Validação**: `typecheck`/`build` limpos; `npm test` **91/91** (6 novos, incluindo retry do
rate-overlimit, 409 = já no grupo e limite persistente); E2E contra a **Evolution real**: job
2/2 processados em background, 1 adicionado e 1 recusado (número inexistente → "participante 451"),
grupo com os mesmos 5 participantes (sem efeito colateral).

---

## 2026-10-21 | E6-PIL-02 | "Religar" loop parado + config salva ao parar

**Sintoma**: "envios de mensagens parado". Diagnóstico: o **Monitor seguia encaminhando** (ENCAMINHADA a
cada 2 min), mas o **Piloto** estava parado — o log mostrava `#1 ⏹️ parado e removido do grid` (10:12).
Nenhum handler de SIGTERM chama `stop()`: foi o botão ⏹ do painel.

**Problema de UX encontrado**: `stop(id)` REMOVIA o loop da grade, então o "▶ START" criava um loop
**novo** (duplicando) e o operador tinha que redigitar conta/categoria/grupo.

**Correções**:
- `src/ml/piloto.ts` — `stop(id)` agora **guarda a config** do loop parado nos `presets` (até 5);
  novo `religar(id)` religa um loop pausado **ou** uma config salva (1 clique, sem redigitar nada);
  `status()` expõe os presets.
- `src/manager/server.ts` — `POST /api/piloto/religar`; na aba Piloto, cada loop parado ganha botão
  **▶ religar**, e as configs salvas aparecem listadas com o mesmo botão.

**Contexto adicional**: às 10:05 o WhatsApp derrubou a sessão do número principal
(`device_removed` / 401 → LOGOUT). A outra instância (`radar-mano-da-divulgacao-cfb`, open) assumiu
os envios — a rotação evitou a parada total. O número principal precisa de **re-pareamento por QR**
(aba Números → botão QR).

---

## 2026-10-21 | E6-GRP-01 | "Evolution inacessível" no painel: rotas unificadas + cache de grupos

**Sintoma**: no painel, a lista de grupos mostrava *"Evolution inacessível: This operation was
aborted — mostrando a última lista salva"*.

**Diagnóstico**: a rota `/api/grupos` (usada pelo select de grupo da aba Piloto/Contas) fazia um
**fetch próprio** com timeout de **45s** e **cache só em memória** — não era a mesma função
`listarGrupos()` da rota `/api/monitor/whats-grupos`, e portanto **não gravava o cache em disco**
(`data/grupos-cache.json` estava com 19,6h de idade). Com a conta no limite do WhatsApp, o
`fetchAllGroups` passava de 45s → abort → o painel caía na lista salva (que nunca era atualizada).

**Correções**:
- `src/manager/server.ts` — `/api/grupos` agora usa a **mesma** `listarGrupos()` (um único cache em
  memória + o cache em disco, refrescado a cada sucesso).
- `src/monitor/evolution.ts` — timeout do `fetchAllGroups` 90s → **120s** (a Evolution leva 12-20s
  com a conta limitada; 45s era apertado).
- Aviso no painel mais claro: *"Evolution demorou demais — mostrando a última lista salva (de N min
  atrás)"*, e a opção do select passa a mostrar o aviso.
