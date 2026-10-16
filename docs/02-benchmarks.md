# 02 — Benchmarks — autoMensagemWhats

> Data da pesquisa: 2026-10-12 | Fontes via websearch (não inventadas, ver Links)

## 1. Decisão central: como enviar WhatsApp

| Solução | Features | Licença | Atividade | Prós | Contras | Custo (BR, 2026) |
|---|---|---|---|---|---|---|
| **WhatsApp Cloud API (oficial Meta)** | REST+webhooks, templates, botões, Flows, carrossel, quality rating verde/amarelo/vermelho | Serviço Meta (ToS oficial) | Mantida pela Meta, SLA | Risco de ban por automação ~zero, escala ilimitada pós-tier, DPA/LGPD, erro 131047 impede envio fora da janela (te protege) | Verificação 5-14 dias, outbound exige template aprovado 24-72h, cobrança por msg template desde 01/07/2025, 1 nº por display name | Marketing ~R$0,25/conversa, utility ~R$0,08; 1000 service grátis/mês; a partir de 01/10/2026 até service em janela passa a ser cobrado (recalcular) |
| **Evolution API (sobre Baileys)** | REST+webhooks, multi-instância, texto/mídia/enquete/reação/grupos/status/typing, sem template | Apache-2.0 / MIT (open source) | Muito ativa, comunidade BR enorme, Docker-friendly | Setup em minutos via QR, custo zero por msg, liberdade total, nº comum continua no celular | Não-oficial (viola ToS), ban sem aviso nem recurso, sessão cai (Connection Closed), quebra quando Meta muda protocolo | VPS R$50-300/mês + IP dedicado R$20-80/nº |
| **Baileys puro (WhiskeySockets/Baileys v7)** | Lib TS baixo nível, WebSocket multi-device sem browser, leve | MIT | 9.9k stars, v7.0.0-rc13 mai/2026 | Leve, muitas sessões no mesmo HW, controle total | Exige implementar tudo (sessão, fila, webhook), mesmo risco ToS | Só infra |
| **whatsapp-web.js (wwebjs)** | Lib JS via Puppeteer+Chromium, paridade total com web client | Apache-2.0 | 22k stars, v1.34.7 2026, iniciantes | Mais popular, doc vasta, fácil começar | 1 browser por sessão (RAM/CPU alto) + risco ToS | Só infra (maior) |
| **WPPConnect + server** | Puppeteer + REST+Swagger multi-sessão | LGPL-3.0 | 3.3k stars, v2.2.1 mai/2026 | Pronto p/ agências, multi-linha | Copyleft (cuidado em produto fechado) + browser pesado | Só infra |
| **whatsmeow / OpenWA** | Go (whatsmeow MPL-2.0) / NestJS gateway plugável (OpenWA MIT, engine trocável baileys/web.js) | MPL-2.0 / MIT | Ativos | Alta perf Go; OpenWA com dashboard+Postgres+webhook UI | Go foge da stack Node proposta; OpenWA ainda novo, validar | Só infra |

**Recomendação 3 níveis:**
- **Ideal (MVP):** Evolution API self-hosted (Docker) + abstração `Provider` para migrar para Cloud API sem reescrever CRM. Motivo anti-retrabalho: valida em dias, isola risco ToS por nº secundário, mantém porta aberta p/ oficial.
- **Alternativa:** Cloud API direto se volume <1000 conversas/mês (grátis) ou setor regulado/marca verificada desde o dia 1.
- **Evitar:** Venom v5.3.0 (parado desde nov/2024), WPPConnect em produto fechado sem assessment LGPL, disparo em massa p/ base fria em qualquer stack (ban certo + viola LGPD).

> Estratégia híbrida validada pelo mercado: nº principal em Cloud (campanhas opt-in) + nºs operacionais em Evolution (inbound/grupos). Um IP dedicado BR por nº não-oficial; ritmo conservador; aquecimento; backup aquecido.

## 2. Fonte de dados Mercado Livre Afiliados

| Solução | Features | Licença | Prós | Contras | Custo |
|---|---|---|---|---|---|
| Painel oficial + Barra de Afiliados | Gerador 1-a-1, encurtador `meli.la`, etiquetas | ToS ML | Oficial, comissão garantida 30d, até 16% | Manual, sem API pública, só no PC | Grátis |
| Bot do Afiliado API (`/convert-links` + `/product`, header `X-API-Key: bk_...`) | Converte 1-150 links, retorna título/preço/imagem/histórico | Serviço privado | Automatiza o que ML não expõe, detecta site pela URL | Depende de cookie de sessão (expira), exige tag+cookie | Plano do serviço |
| Afilimax `@afilimax/mercado-livre-provider` (npm, set/2026) | `createAffiliateUrl()` com tag+cookies, suporta `meli.la` | MIT (verificar) | Código aberto, integra direto no Node | Mesmo calcanhar do cookie, exige etiquetas reserva | Grátis + manutenção |
| Garimpei API REST (open source BR) | `POST /extract {userId,url}` → marketplace, título, preços, desconto, frete, vendidos, imagem | Open source | Foco em afiliado, multi-marketplace (ML/Amazon/Nike/Centauro), shortlink `/s/:code`, extensão Chrome p/ `ssid` | Self-host, valida cookies em `/config/cookies` | Infra |

**Recomendação:** MVP usa **Afilimax ou Garimpei self-host** (código sob seu controle) com fallback manual (colar preço). Se pressa > controle, assina Bot do Afiliado. Em todos: criar ≥2 etiquetas reserva (ML reaproveita link antigo e às vezes cai no perfil, não no produto) + rotina de refresh de cookie + retry só de `ok:false`.

## 3. Geração de copy com IA (EngAI)
- Router: simples (reescrita) → modelo local/free (Ollama gemma/llama, OpenRouter free); complexa (headline nova) → Claude/GPT/Gemini pago.
- Gateway: `App → Router+Cache+RAG+Guardrail → Modelo → Approval Gate → trace.json` (custo/latência por chamada).
- RAG: docs do projeto + runbooks + material glide.page; chunks 512-1024 tok overlap 10%.
- Guardrails: sanitize input, allowlist tools, nunca executar instrução vinda de dado (título do produto pode conter injection), temperatura 0.1-0.2 p/ extração, 0.7 p/ ideação, formato TOON p/ contexto grande, JSON p/ contrato estrito.
- Decisão fine-tune vs RAG: dados mudam todo dia → **RAG + prompts, não fine-tune**.

## 4. Benchmark funcional (o que o mercado faz)
Mensagem campeã tem sempre: foto quadrada clara + HEADLINE caixa alta negrito + urgência itálico ‼️ + nome + âncora `~De~ *Por Pix* *Ou parc*` + `⚠️ Cupom: X` + `🛒 Link ⤵️ url`. Nosso template replica isso 1:1 (ver `docs/07-prototipo-resultado.md`).

## 5. Riscos mapeados nos benchmarks
1. Ban Evolution em ondas 2023-2025, detecção mais rápida em 2026 (dias/semanas acima de limiar).
2. Preço Cloud mudou 01/07/2025 (por msg) e muda de novo 01/10/2026 (service em janela passa a cobrar) — recalcular antes da Sprint 3.
3. Baileys quebra a cada update de protocolo Meta — pinar versão exata v7 + monitorar.
4. Cookie ML expira sem aviso — job de health-check diário.
5. IP datacenter compartilhado derruba nºs juntos — 1 IP BR dedicado por nº.

## Links (só o retornado pelo search)
- https://manager360.openexo.com.br/blog/whatsapp-business-api-vs-evolution-api
- https://blog.tipefy.com/api-oficial-do-whatsapp-vs-evolution-api-e-baileys-o-que-muda-na-pratica-para-sua-empresa
- https://devactivo.com/blog/evolution-api-vs-whatsapp-business-api/ (2026-05-21)
- https://proxybox.com.br/blog/api-oficial-whatsapp-vs-evolution-baileys (2026-09-17)
- https://proxyads.com/blog/whatsapp-api-oficial-vs-nao-oficial/ (2026-07-17)
- https://blog.evofoundation.com.br/evolution/evolution-api/baileys-ou-whatsapp-cloud-api-como-escolher-o-tipo-de-conexao-na-evolution-api
- https://botdoafiliado.com/blog/api-de-afiliados-do-mercado-livre/ + https://botdoafiliado.com/docs/integracoes/mercado-livre/
- https://www.mercadolivre.com.br/l/afiliados-gere-seus-links + https://mercadolivre.com.br/l/afiliados-home
- https://rallydevendas.com.br/blog/como-criar-link-afiliado-mercado-livre
- https://whatsapp.checkleaked.cc/blog/best-open-source-whatsapp-libraries (2026-06-20)
- https://github.com/pedroslopez/whatsapp-web.js/ + https://github.com/orkestral/venom/
