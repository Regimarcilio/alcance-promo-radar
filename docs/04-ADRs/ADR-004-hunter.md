# ADR-004 — Hunter autônomo por categoria

> Data: 2026-10-12 | Status: Aceita (v0.2)

## Contexto
v0.1 exigia URL manual. Usuário quer: escolher categoria → sistema acha oportunidades → gera → envia sozinho.

## Decisão
Scheduler cron (default 2h, janela 8h-22h) + Hunter (search Top50 ML via Garimpei/Afilimax estendido, cache 2h) + Scorer com pesos fixos e motivo legível + histórico SQLite p/ queda real + anti-duplicidade 7d por hash + modos REVISÃO (default) / AUTO (com `AUTO_APROVADO=true` + limite 10/dia + kill-switch).

## Consequências
+ Zero garimpagem manual, só as melhores caem no grupo. - Search sofre rate-limit (mitigar com intervalo + backoff); falso De exige histórico; AUTO aumenta risco ban → começar em REVISÃO 1 semana.
