# 06 — Plano de Entrega — autoMensagemWhats

> v0.1 | 2026-10-12 | Branch: `develop`

## 1. Estrutura proposta (criar na Sprint 1)
```
autoMensagemWhats/
  image/ (evidência base)
  docs/ (este planejamento + prototipo/)
  src/cli.ts oferta/ ml/ ai/ wa/ store/ obs/
  docker-compose.yml (app + evolution)
  .env.example (TAG_ML, COOKIE_ML, EVO_URL, EVO_KEY, LLM_KEYS)
  package.json (type:module, Node>=20)
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
cp .env.example .env  # preencher TAG/COOKIE
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

## 5. Estratégia de envio (piloto seguro)
Dia1 ≤20, dia2 ≤35, dia3+ ≤50 msgs/dia/nº; intervalo ≥30s; 1 IP BR/nº; backup aquecido; opt-in comprovável; fora janela Cloud só template; horário comercial salvo flag.

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
