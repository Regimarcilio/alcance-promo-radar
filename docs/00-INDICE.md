# 00 — Índice da documentação — Alcance

> Atualizado em 2026-10-22 · Branch `develop` · Versão do produto: `0.8.0` (64 commits)
> Este índice é a porta de entrada. Ele diz **qual documento vale hoje**, qual é retrato histórico e
> o que ainda está planejado. Em caso de conflito, prevalecem o código em `src/` e o SRS vigente.

## Como ler

- **vigente** — descreve o comportamento atual ou uma decisão ainda válida; pode ser usado como fonte.
- **histórico** — retrato de um momento anterior. Não usar para onboarding nem para decidir.
  O conteúdo foi preservado; o banner no topo aponta o substituto.
- **planejado** — documento ou versão ainda não produzida.

## Documentos

| Documento | Versão / data | Status | Substitui / substituído por |
|---|---|---|---|
| [`README.md`](../README.md) | 2026-10-22 | vigente | Substitui o onboarding antigo (nome autoMensagemWhats, porta 8091, 22 testes). |
| [`CHANGELOG.md`](../CHANGELOG.md) | 0.8.0 · 2026-10-22 | vigente | Primeiro changelog formal; consolida o histórico recente do `dev-log.md`. |
| [`docs/00-INDICE.md`](00-INDICE.md) | 2026-10-22 | vigente | — |
| [`docs/01-visao-e-escopo.md`](01-visao-e-escopo.md) | v0.2 · 2026-10-12 | histórico | Visão do produto antigo (autoMensagemWhats/Hunter). Escopo atual: SRS v0.4 e README. |
| [`docs/02-benchmarks.md`](02-benchmarks.md) | 2026-10-12 | vigente | Referência de decisões iniciais (Evolution vs Cloud, fontes ML, IA). Nomes antigos de fornecedores foram superados pelos ADRs 001–010. |
| [`docs/03-arquitetura-e-uml.md`](03-arquitetura-e-uml.md) | v0.1 · 2026-10-12 | vigente (com ressalvas) | Diagramas ainda úteis; cita SQLite/CloudProvider que **não existem**. Ler junto do SRS v0.4 e ADRs. |
| [`docs/03-arquitetura-v0.2-delta.md`](03-arquitetura-v0.2-delta.md) | v0.2 · 2026-10-12 | histórico | Delta do Hunter; absorvido pelo SRS v0.4 (RF-015–021). |
| [`docs/04-ADRs/README.md`](04-ADRs/README.md) | 2026-10-22 | vigente | Índice das decisões arquiteturais. |
| [`docs/04-ADRs/ADR-001-envio-whatsapp.md`](04-ADRs/ADR-001-envio-whatsapp.md) | 2026-10-12 | vigente | Evolution v2 em produção; `CloudProvider` é apenas possibilidade futura (não implementado). |
| [`docs/04-ADRs/ADR-002-ia-gateway.md`](04-ADRs/ADR-002-ia-gateway.md) | 2026-10-12 | vigente (com ressalvas) | A interface existe, mas o gateway atual é stub local determinístico (custo 0). Modelos pagos não foram ligados. |
| [`docs/04-ADRs/ADR-003-fonte-ml.md`](04-ADRs/ADR-003-fonte-ml.md) | 2026-10-12 | histórico | Afilimax/Garimpei não estão no código. A fonte real é o endpoint interno do ML + página do item (`src/ml/provider.ts`, `src/ml/item-page.ts`). |
| [`docs/04-ADRs/ADR-004-hunter.md`](04-ADRs/ADR-004-hunter.md) | 2026-10-12 | vigente (com ressalvas) | Hunter existe sem SQLite e sem cron próprio; o Piloto chama `hunt` em memória. |
| [`docs/04-ADRs/ADR-005-auth-sessao-2fa.md`](04-ADRs/ADR-005-auth-sessao-2fa.md) | 2026-10-22 | vigente | Implementa login/sessão/default-deny + rate-limit/auditoria + 2FA por WhatsApp (RF-036, RF-040, RF-041). |
| [`docs/04-ADRs/ADR-006-multi-numero-rotacao.md`](04-ADRs/ADR-006-multi-numero-rotacao.md) | 2026-10-22 | vigente | Rotação ponderada, principal × secundários e fallback (RF-042, RF-054). |
| [`docs/04-ADRs/ADR-007-clientes-campanhas.md`](04-ADRs/ADR-007-clientes-campanhas.md) | 2026-10-22 | vigente | Sync de participantes, listas, campanha e adição em gotejamento (RF-045, RF-046, RF-047). |
| [`docs/04-ADRs/ADR-008-ui-temas.md`](04-ADRs/ADR-008-ui-temas.md) | 2026-10-22 | vigente | 6 paletas via `data-paleta` + `localStorage`, títulos em `data/ui.json` (RF-048, RF-049). |
| [`docs/04-ADRs/ADR-009-shopee-open-api.md`](04-ADRs/ADR-009-shopee-open-api.md) | 2026-10-21 | vigente | `generateShortLink`; validação live ainda depende de credenciais (RF-032, RN-023). |
| [`docs/04-ADRs/ADR-010-verificacao-celular-favoritos-ml.md`](04-ADRs/ADR-010-verificacao-celular-favoritos-ml.md) | 2026-10-21 | vigente | Complementa o ADR-005 (2FA) e registra favoritos do ML (RF-036, RF-037). |
| [`docs/05-backlog.md`](05-backlog.md) | v0.3 · 2026-10-17 | histórico | Para em US-20; não cobre auth, clientes, multi-número, temas nem as entregas E6 recentes. Banner no topo. |
| [`docs/05-backlog-v0.4.md`](05-backlog-v0.4.md) | v0.4 · 2026-10-22 | vigente | Substitui o v0.3; cobre 100% dos RF do SRS v0.4 (US-21+), com DoR/DoD, estados e evidência. |
| [`docs/06-plano-de-entrega.md`](06-plano-de-entrega.md) | v0.3 · 2026-10-17 | histórico | Comandos e stack antigos (SQLite, Afilimax, `atendai/evolution-api`, `lote:approve`). Banner no topo. |
| [`docs/07-prototipo-resultado.md`](07-prototipo-resultado.md) | v0.3 · 2026-10-12 | histórico | Referência visual do protótipo HTML; não descreve o painel atual. |
| [`docs/08-deploy-rede-limpa.md`](08-deploy-rede-limpa.md) | 2026-10-13 | histórico/legado | Migração do projeto autoMensagemWhats; caminho, URL, porta e comandos antigos. Banner no topo. |
| [`docs/10-cesta-semente.md`](10-cesta-semente.md) | 2026-10-12 | vigente | Fonte importável por `npm run dev -- cesta:importar` (formato `MLB | url | pix | de | titulo | foto`). |
| [`docs/11-padrao-emipe.md`](11-padrao-emipe.md) | RN-001 v3 · 2026-10-22 | vigente | v2 (2026-10-14) marcada como histórica. Template real em `src/wa/formatter.ts`. |
| [`docs/12-auditoria-consistencia.md`](12-auditoria-consistencia.md) | 2026-10-19 | histórico | **Retrato histórico** (nota 6,5/10, "zero testes", sem remoto). Banner no topo. |
| [`docs/13-auth-spec.md`](13-auth-spec.md) | 2026-10-20 | vigente | Spec + implementação de login/sessão; complementada pelo ADR-005 e RF-036. |
| [`docs/14-relatorio-geral.md`](14-relatorio-geral.md) | 2026-10-21 | histórico | **Retrato histórico** (22 testes, notas e pendências daquele dia). Banner no topo. |
| [`docs/15-plano-sincronizacao-docs.md`](15-plano-sincronizacao-docs.md) | 2026-10-22 | vigente | Plano de sincronização; §9 registra o que foi concluído nesta rodada e o que segue pendente. |
| [`docs/SRS.md`](SRS.md) | v0.3 · 2026-10-17 | histórico | Substituído por [`docs/SRS-v0.4.md`](SRS-v0.4.md). Contém SQLite/Afilimax/CloudProvider/EngAI fictícios. |
| [`docs/SRS-v0.2-delta.md`](SRS-v0.2-delta.md) | v0.2 · 2026-10-12 | histórico | Absorvido pelo SRS v0.4 (RF-015–021 e RNs correspondentes). |
| [`docs/SRS-v0.4.md`](SRS-v0.4.md) | v0.4 · 2026-10-22 | vigente | Substitui SRS v0.3 + delta v0.2. Fonte de requisitos atual. |
| [`docs/dev-log.md`](dev-log.md) | append-only · 2026-10-22 | vigente | Diário de bordo com evidência por entrega; complementa (não substitui) o CHANGELOG. |
| [`docs/prototipo/index.html`](prototipo/index.html) | 2026-10-12 | histórico | Protótipo visual original; não é o painel em produção. |
| [`docs/prototipos/auth/README.md`](prototipos/auth/README.md) | 2026-10-20 | histórico | Protótipos de login que originaram a opção implementada (ADR-005). |

## Ordem de leitura recomendada

1. `README.md` — o que é e como subir.
2. `docs/SRS-v0.4.md` — requisitos vigentes e rastreabilidade.
3. `docs/04-ADRs/README.md` — por que as decisões foram tomadas.
4. `docs/13-auth-spec.md` — detalhes de autenticação e checklist de segurança.
5. `CHANGELOG.md` + `docs/dev-log.md` — o que mudou e qual foi a evidência.
6. `docs/14-relatorio-geral.md` / `docs/12-auditoria-consistencia.md` — somente como contexto histórico.

## Pendências documentais conhecidas

- Backlog v0.4 já produzido ([`docs/05-backlog-v0.4.md`](05-backlog-v0.4.md)); `docs/05-backlog.md` (v0.3) fica como histórico.
- `docs/01-visao-e-escopo.md` e `docs/03-arquitetura-e-uml.md` continuam com nomes e stack antigos
  (SQLite/CloudProvider). Foram marcados como históricos/com ressalvas, não reescritos nesta rodada.
- `docs/06` e `docs/08` foram marcados como históricos; comandos antigos não foram reescritos linha a linha.
- Validação live de Shopee e Amazon Creators depende de credenciais externas.
