# ADR-009 — Shopee: link de afiliado via Open API (`generateShortLink`)

> Data: 2026-10-21 | Status: Aceita (implementação pronta; validação live pendente de credenciais)

## Contexto

O `src/monitor/transformer.ts` tratava `SHOPEE_SUBID` como se fosse link de afiliado, anexando `smtt` à URL e devolvendo `ok: true`. `smtt` é parâmetro de rastreio do app Shopee, **não** é atribuição de afiliado: o link continuava sem comissão e, pior, era enviado direto porque `ok: true` pulava a fila de revisão (violação da RN-012).

A Shopee oferece Open API oficial com a mutation `generateShortLink`, que recebe uma URL de produto/loja e devolve um link curto `https://shope.ee/...` com o `affiliate_id` do usuário. A autenticação é por assinatura SHA-256.

## Decisão

- Usar `POST https://open-api.affiliate.shopee.com.br/graphql` com a mutation `generateShortLink(input: { originUrl, subIds })`.
- Autenticar com `Authorization: SHA256 Credential={AppId}, Timestamp={Timestamp}, Signature={Signature}`, onde `Signature = SHA256(AppId + Timestamp + Payload + Secret)` e `Timestamp` é Unix em segundos.
- Configurar por `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET` e `SHOPEE_SUB_IDS` (até 5, separados por vírgula). `SHOPEE_SUBID` legado vira o primeiro sub ID quando a lista nova não existe.
- **Sem credenciais ou em qualquer falha** (timeout, 401, rate limit, erro GraphQL), devolver `ok: false`, preservar a URL original e mandar para `REVISAO_MONITOR`. Nunca inventar link de afiliado.
- Se apenas `SHOPEE_SUBID` estiver configurado, aplicar `smtt` por compatibilidade, mas manter `ok: false` com aviso explícito de que não gera comissão.
- Cache de 6h por `originUrl + subIds` e timeout de 8s para não repetir chamadas nem travar o webhook.

## Consequências

- **+** Corrige a atribuição de comissão e impede o envio de link Shopee não afiliado.
- **+** Módulo inerte sem credenciais: nenhuma chamada de rede e comportamento seguro por padrão.
- **+** Testes com `fetch` mockado cobrem sucesso, cache, limite de sub IDs e falhas.
- **−** Depende de aprovação da Shopee em `affiliate.shopee.com.br/open_api` (resposta informada em até ~2 semanas).
- **−** O schema GraphQL pode mudar; a validação live com credenciais reais fica pendente.
- **−** O link curto não traz título/foto do anúncio; o template continua usando o texto da origem.

## Referências

- Implementação: `src/monitor/shopee-api.ts`, `src/monitor/transformer.ts`
- Issue: #8
- SRS: RF-032 / RN-012
- Backlog: US-18
- Docs Shopee: `affiliate.shopee.com.br/open_api`
