# ADR-002 — IA via Gateway EngAI com approval, nunca direta

> Data: 2026-10-12 | Status: Aceita

## Contexto
IA deve criar headlines/urgências sem alucinar preços/links e sem estourar custo.

## Decisão
Fluxo `App → Gateway(Router+Cache+RAG+Guardrail) → Modelo → Approval → trace.json`. Router: cheap (local/free) p/ reescrita, smart (pago) p/ criação. Temp 0.1 extração, 0.7 ideação. Zod valida que números/link/cupom intactos. Fallback sempre template fixo. RAG (não fine-tune) com docs + glide.page.

## Consequências
+ Custo auditável, sem mutação silenciosa, anti-injection. - Latência maior + manter prompts versionados em `src/ai/prompts/*.toon.md`.
