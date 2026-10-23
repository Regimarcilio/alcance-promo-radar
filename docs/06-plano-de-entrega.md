# 06 — Plano de Entrega — promo-radar-novo

> **PLANEJAMENTO HISTÓRICO (v0.3, 2026-10-17).** Escrito antes da implementação. A estrutura de
> pastas, variáveis de ambiente e o modo "duplo" evoluíram: o projeto hoje está em **v0.8.0** e a
> fonte vigente de requisitos é [`SRS-v0.4.md`](SRS-v0.4.md); o índice geral é
> [`00-INDICE.md`](00-INDICE.md). Onde houver divergência, valem o SRS v0.4 e o código.

> v0.3 | 2026-10-17 | Branch: `develop` | Modo duplo: AUTOMÁTICO (E1–E5) + MONITOR (E6)

## 1. Estrutura proposta (criar na Sprint 1)
```
promo-radar-novo/
  image/ (evidência base)
  docs/ (este planejamento + prototipo/)
  src/cli.ts oferta/ ml/ ai/ wa/ store/ obs/
  src/monitor/            ← NOVO: webhook, parser, transformer, router, state
  docker-compose.yml (app + evolution)
  .env.example (TAG_ML, COOKIE_ML, EVO_URL, EVO_KEY, MANAGER_KEY, MANAGER_PORT, QUARENTENA_H, QTD_PILOTO, INTERVALO_S, MONITOR_GRUPOS, MONITOR_DESTINOS, WEBHOOK_KEY)
  package.json (type:module, Node>=20)
  docs/prototipo/index.html (HTML prototype com campos qtd/intervalo + aba Monitor)
```

## 2. Setup por stack (Node+TS)
```bash
nvm use 20 && npm init -y && npm i -D typescript tsx @types/node
npm i zod pino sqlite3
# ML
npm i @afilimax/mercado-livre-provider
# WA MVP
docker run -p 8080:8080 atendai/evolution-api:latest
# IA (opcional S3)
npm i ollama-ai-provider ai
cp .env.example .env  # preencher TAG/COOKIE/MANAGER_KEY/MANAGER_PORT/QUARENTENA_H/QTD_PILOTO/INTERVALO_S
npm run dev -- oferta:add https://meli.la/2aKpCmQ
```

## 3. Branches (padrão skill planmaster-git)
- Ativa: `develop`. Fluxo: `main ← release/* ← develop ← ISSUE|DEV|SEG|DOC`.
- Nomes EXATOS: `ISSUE`, `DEV`, `SEG`, `DOC` (recriar após merge, sem sufixos).
- Commits: `type(scope): desc` — `docs, plan, feat, fix, chore, refactor, test`.
- Sequência: `git status -sb` → `git diff --stat` → `checkout develop` → `add docs/` → `commit` → `push -u origin develop` (sem `--force`, sem commit em `main`).

## 4. CI mínimo (Sprint 2)
- `npm run typecheck + test + sast (sem segredo/PII)` no PR para `develop`.
- Snapshot test do formatter vs exemplo Orient deve passar.
- `trace.json` anexado como artefato quando IA usada.
- Verificar se `qtd` e `intervaloS` são tipos corretos no TypeScript (compile-time check).
- **Monitor:** teste do parser com 1 link de cada programa (ML/Shopee/Kabum/Amazon) e teste de anti-loop (destino ≠ origem).

## 4.A Monitor — setup do webhook (E6)
```bash
# 1. Subir o manager (já expõe POST /api/webhook/evolution)
docker compose up -d manager

# 2. Configurar webhook no Evolution API (events: messages.upsert)
curl -X POST "$EVO_URL/webhook/set/$EVO_INSTANCE" \
  -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  -d '{"url":"http://manager:8091/api/webhook/evolution","webhook_by_events":false,
       "events":["MESSAGES_UPSERT"],"headers":{"X-Webhook-Key":"'$WEBHOOK_KEY'"}}'

# 3. Cadastrar grupos monitorados e destinos pela interface (aba Monitor)
#    Origem de teste: https://chat.whatsapp.com/INVITE_REDACTED_0000000 (grupo ML/afiliados)

# 4. Validar
curl -s http://127.0.0.1:8091/api/monitor/status | jq
```
Fluxo: `messages.upsert` → parser (RF-031) → transformer (RF-032) → template (RF-033) → router (RF-034) → dedup anti-loop (RF-035).

## 5. Estratégia de envio (piloto seguro)
Dia1 ≤20, dia2 ≤35, dia3+ ≤50 msgs/dia/nº; intervalo ≥30s; 1 IP BR/nº; backup aquecido; opt-in comprovável; fora janela Cloud só template; horário comercial salvo flag.

**Novos parâmetros:**
- `qtd`: quantidade de mensagens por ciclo (1 ou 2). Dia1 ≤20 ciclos com qtd=1, dia2 ≤35 com qtd=2 (proporcional).
- `intervaloS`: respiro humano entre as 2 do ciclo (45–90s com jitter ±10s). Não substituir o respiro de 8 min a cada 55 min.

## 6. Checklist anti-retrabalho (handoff p/ DEV)
- [ ] Confrontou `docs/` com https://integrador-cedup.glide.page/dl/a400f7?
- [ ] `meli.la` abre produto (não perfil)? Etiquetas reserva criadas?
- [ ] Cookie ML válido (health-check verde)?
- [ ] Sessão Evolution QR ativa?
- [ ] Formatter snapshot verde?
- [ ] Approval gate testado (sem approval = erro)?
- [ ] `.env` fora do git? Telefone do print anonimizado?
- [ ] `trace.json` com custo do lote?
- [ ] Plano rollback (trocar nº/provider sem reescrever)?
- [ ] **Campos novos:** `qtd ∈ {1,2}` e `intervaloS ∈ {45, 60, 90}` presentes no `PilotoCfg` e na interface START?
- [ ] **Campos novos:** `nome` do cupam está sendo salvo e exibido corretamente (`PRIMEHOJE (10% OFF Voltagem)`)?
- [ ] **Monitor:** webhook `messages.upsert` aponta para `POST /api/webhook/evolution` com `X-Webhook-Key`?
- [ ] **Monitor:** grupos de origem e destino cadastrados (máx 10) na aba Monitor?
- [ ] **Monitor:** parser reconhece ML/Shopee/Kabum/Amazon; domínio fora da allowlist → `NAO_RECONHECIDO`?
- [ ] **Monitor:** anti-loop validado (nenhum destino = origem) e dedup 7d verde?
- [ ] **Monitor:** contador diário compartilhado com o modo automático (RN-013) não estoura RN-007?

## 7. Próximos comandos
```bash
git checkout develop
# Sprint 1:
npm run dev -- oferta:add <URL_ML>  # gera preview em docs/prototipo/
xdg-open docs/prototipo/index.html
# Piloto:
docker compose up -d && npm run dev -- lote:approve --send --dry-run
```

## 8. Handoff EngAI
Escopo EngAI: `src/ai/gateway.ts`, `prompts/*.toon.md`, `tools/*`, `ADR-002`, `trace.json`. Fora do escopo: reversa invasiva de protocolo WhatsApp, spam, fine-tune.
