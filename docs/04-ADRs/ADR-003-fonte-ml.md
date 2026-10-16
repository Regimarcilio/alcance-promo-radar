# ADR-003 — Fonte ML: Afilimax/Garimpei self-host + fallback manual

> Data: 2026-10-12 | Status: Aceita

## Contexto
ML não tem API pública de afiliados; conversor depende de tag+cookie que expira e às vezes gera link que cai no perfil, não no produto.

## Decisão
Self-host Afilimax `MercadoLivreProvider` ou Garimpei `POST /extract`; exigir ≥2 etiquetas reserva + health-check diário + retry só `ok:false`; fallback manual (colar preços/link) sempre disponível. Divulgar só `final_url`.

## Consequências
+ Controle total, sem lock-in. - Manter refresh de cookie + extensão Chrome p/ `ssid` documentada no runbook.
