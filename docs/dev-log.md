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
