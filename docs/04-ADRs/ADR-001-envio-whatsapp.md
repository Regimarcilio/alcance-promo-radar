# ADR-001 — Envio WhatsApp: Evolution MVP + abstração para Cloud

> Data: 2026-10-12 | Status: Aceita

## Contexto
Precisamos enviar imagem+legenda para grupo opt-in em dias, mas Cloud oficial exige verificação 5-14 dias + templates e cobra por msg (muda 01/10/2026). Evolution é instantânea e grátis por msg, porém não-oficial com risco de ban.

## Decisão
`DispatchProvider` interface; MVP `EvolutionProvider` (Docker, QR, 1 IP BR/nº, ritmo RN-007); `CloudProvider` implementado na Sprint 3 sem reescrever CLI. Piloto em nº secundário, ≤50 msgs/dia.

## Consequências
+ Valida rápido, isola risco, migra sem retrabalho. - Manter 2 providers + monitorar sessões Baileys (pinar v7).
