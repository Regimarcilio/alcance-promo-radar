# SRS — Software Requirements Specification — promo-radar-novo

> Versão 0.3 | 2026-10-17 | Branch `develop` | Stack alvo: Node 20+ ESM + TypeScript + Evolution API + Afilimax/Garimpei + EngAI Gateway
> Modo duplo: **AUTOMÁTICO** (envio de ofertas ML, RF-001–023) + **MONITOR** (receber/transformar/encaminhar, RF-030–035)
> Referência visual: `image/Screenshot_20261011_223512_WhatsApp.jpg` | Curso: https://integrador-cedup.glide.page/dl/a400f7

## 1. Introdução
### 1.1 Propósito
Especificar o gerador + disparador de mensagens promocionais WhatsApp para afiliados ML, eliminando montagem manual e garantindo padronização, rastreabilidade e compliance.

### 1.2 Escopo
Inclui: ingestão de oferta, enriquecimento ML, geração de copy (template + IA opcional), formatação WhatsApp, preview, approval, envio, logs. Exclui: ver `docs/01-visao-e-escopo.md §5`.

### 1.3 Definições
WABA, Cloud API, Evolution API, Baileys, `meli.la`, Tag/Etiqueta ML, Template HSM, Approval Gate, trace.json, MoSCoW.

### 1.4 Referências
`docs/01-visao-e-escopo.md`, `docs/02-benchmarks.md`, imagem base, docs Meta Cloud API, docs Evolution API, docs Afilimax/Garimpei.

## 2. Descrição geral
### 2.1 Perspectiva do produto
CLI + lib Node (`src/`) + protótipo HTML. Arquitetura: `Ingest → Enrich(ML) → Copy(Template/IA) → Format → Preview → Approve → Dispatch(Provider) → Observe`.

### 2.2 Usuários
- OP (operador/afiliado): cadastra oferta, revisa, aprova.
- ADM (admin canal): agenda, autoriza lote.
- SISTEMA (jobs): health-check cookie/sessão, retry, métricas.

### 2.3 Restrições
R1 Node ≥20 ESM; R2 sessão Evolution via QR; R3 cookie ML expira; R4 fora da janela 24h Cloud exige template; R5 LGPD: anonimizar telefones de prints, opt-in obrigatório; R6 sem disparo p/ base fria.

### 2.4 Premissas
P1 tag ML válida; P2 grupo piloto opt-in; P3 VPS com Docker; P4 modelo LLM com fallback offline.

## 3. Requisitos funcionais

### RF-001 — Cadastrar oferta por URL ML (Must)
**Ator:** OP. **Desc:** aceitar `url` (qualquer domínio ML/`meli.la`), validar, salvar rascunho.
**Aceite (Gherkin):**
```gherkin
Dado que sou OP
Quando cadastro "https://meli.la/2aKpCmQ"
Então o sistema cria oferta com status RASCUNHO e normaliza para URL canônica em <2s
```

### RF-002 — Enriquecer dados do produto (Must)
**Ator:** SISTEMA. **Desc:** retornar título, imagem, preco_de, preco_pix, preco_parc, parcelas, link_afiliado via provider (Afilimax/Garimpei/BotDoAfiliado) com retry só de `ok:false`.
**Aceite:**
```gherkin
Dado uma oferta RASCUNHO
Quando enriqueço
Então tenho todos os 7 campos ou erro tipado COOKIE_EXPIRED/LINK_FALLBACK com instrução de refresh
```

### RF-003 — Cadastro manual fallback (Should)
Aceitar título, preços, imagem local/URL, cupom, link quando provider falhar.

### RF-004 — Gerar copy template fixo (Must)
Aplicar template §5 sem IA, idêntico ao padrão da imagem (headline, urgência, âncora, cupom, CTA).

### RF-005 — Gerar variações com IA via Gateway (Should, EngAI)
Router barato/caro, cache semântico, guardrails, `trace.json` com custo/latência. Temperatura 0.1 extração, 0.7 ideação.
```gherkin
Dado uma oferta enriquecida
Quando peço 5 variações
Então recebo 5 headlines únicas sem alterar preços/link/cupom e com custo registrado
```

### RF-006 — Formatar para WhatsApp (Must)
Converter para `*negrito* _itálico_ ~riscado~` + emojis, validar limite 4096 chars, links clicáveis, preview `meli.la` OK.

### RF-007 — Preview fiel (Must)
Exibir bolha WhatsApp (foto + texto + hora + check) idêntica a `docs/07-prototipo-resultado.md`. Ver protótipo em `docs/prototipo/index.html`.

### RF-008 — Approval gate (Must)
Nenhum lote >1 msg sai sem aprovação explícita OP/ADM; ação destrutiva exige confirmação.

### RF-009 — Envio via Provider abstraído (Must)
Interface `DispatchProvider.send()` com `EvolutionProvider` no MVP e `CloudProvider` futuro sem reescrever; fila, rate-limit (≥30s entre msgs piloto), backoff, QR-reconnect.

### RF-010 — Agendar/enviar para grupo piloto (Must)
Selecionar grupo opt-in, agendar, enviar imagem+legenda (qtd ofertas por ciclo), registrar messageId/status. O usuário configura `qtd ∈ {1,2}` e `intervaloS ∈ {45, 60, 90}` na interface de START.

**Comportamento:**
- Se `qtd = 1`: envia 1 oferta a cada ciclo de 5 min.
- Se `qtd = 2`: envia 2 ofertas por ciclo, com intervalo `intervaloS` segundos de respiro humano entre elas (com jitter ±10s), seguido da pausa de 8 min a cada 55 min.

### RF-022 — Quantidade de postagens por ciclo (Should)
O piloto enviará `qtd` ofertas por ciclo, onde `qtd ∈ {1, 2}`. O usuário escolhe no START do loop:
- `qtd = 1`: uma mensagem por ciclo (intervalo 5 min).
- `qtd = 2`: duas mensagens por ciclo, com intervalo humano entre elas (45–90s com jitter ±10s).
**Aceite:** ao iniciar loop com `qtd=2`, o sistema envia a primeira, espera o intervalo configurado, envia a segunda, então respiro de 8 min a cada 55 min antes do próximo ciclo.

### RF-023 — Intervalo entre postagens dentro do ciclo (Should)
Quando `qtd = 2`, o intervalo entre a primeira e a segunda mensagem será de `intervaloS` segundos, com jitter humano de ±10 segundos para evitar padrão robótico:
- `intervaloS = 45`: ~45s (±5s) entre mensagens
- `intervaloS = 60`: ~1 min (±6s) entre mensagens  
- `intervaloS = 90`: ~1:30 min (±9s) entre mensagens
**Aceite:** o log exibirá "⏱️ respiro humano de XXs entre as 2 do ciclo" e o tempo será respeitado mesmo que o próximo candidato já esteja pronto.

### RF-011 — Histórico e reenvio (Should)
Listar ofertas, status, messageId, reenviar/editar copy.

### RF-012 — Health-check cookie/sessão (Should)
Job diário valida cookie ML e sessão Evolution, alerta em log/`/stats`.

### RF-013 — Observabilidade (Should)
`/stats`, `trace.json` (modelo, tokens, R$, ms), logs estruturados pino.

### RF-014 — Anonimizar PII de prints (Must, LGPD)
Borrar telefones/nomes ao importar screenshot para treino/template mining.

---

## 3.A Modo MONITOR — receber, transformar e reencaminhar (v0.3)

> Funcionalidade nova: monitorar grupos de afiliados, reconhecer links de afiliado e reencaminhar para os grupos próprios com o link do usuário. Convivência com o modo automático (RF-001 a RF-023) na **mesma interface**.

### RF-030 — Monitorar grupos de afiliados (Must)
**Ator:** OP. **Desc:** cadastrar até 10 grupos WhatsApp de origem para monitoramento; receber mensagens entrantes via webhook do Evolution API; ignorar grupos não monitorados.
**Aceite:**
```gherkin
Dado que cadastrei o grupo "INVITE_REDACTED_0000000" como monitorado
Quando chega uma mensagem nesse grupo com link de oferta
Então o sistema registra a mensagem como candidata e segue para análise
E mensagens de grupos não cadastrados são ignoradas
```

### RF-031 — Identificar oferta e programa de afiliado (Must)
**Ator:** SISTEMA. **Desc:** varredura textual da mensagem, extração de URLs e classificação por programa (Mercado Livre, Shopee, Kabum, Amazon) via allowlist de domínios + padrões. Extrair MLB ID/ASIN quando possível.
**Aceite:**
```gherkin
Dado uma mensagem com "https://meli.la/2aKpCmQ"
Quando o parser analisa
Então classifica como Mercado Livre e extrai o link canônico
E links de domínio desconhecido geram status NAO_RECONHECIDO (fila de revisão)
```

### RF-032 — Transformar link para o link de afiliado do usuário (Must)
**Ator:** SISTEMA. **Desc:** converter a URL original para a URL de afiliado do usuário usando os mesmos dados de acesso ML já configurados (tag/cookie do provedor). Reutilizar `src/ml/provider.ts` (`converterLink`/`gerarLinkAfiliado`). Nunca alterar preços/números.

**Shopee (Open API):** usar `POST https://open-api.affiliate.shopee.com.br/graphql` com a mutation `generateShortLink(input: { originUrl, subIds })`, autenticada por `SHA256 Credential={AppId}, Timestamp={Timestamp}, Signature=SHA256(AppId+Timestamp+Payload+Secret)`. Configurar `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET` e `SHOPEE_SUB_IDS` (até 5). Sem credenciais ou em falha, preservar a URL original e enviar para revisão; `smtt` aplicado por `SHOPEE_SUBID` legado **não** conta como transformação válida (não gera comissão).

**Aceite:**
```gherkin
Dado um link ML reconhecido na mensagem
Quando aplico a transformação
Então o link final usa a tag/atribuição do usuário e preserva o produto (nunca cai no perfil)

Dado um link Shopee e SHOPEE_APP_ID/SHOPEE_APP_SECRET configurados
Quando aplico a transformação
Então o link final é o shortLink retornado pela Shopee (ex.: https://shope.ee/...)
E falha ou ausência de credenciais mantém o link original e envia para REVISAO_MONITOR
```

### RF-036 — Verificar celular do usuário no primeiro acesso (Must)
**Ator:** SISTEMA. **Desc:** no cadastro, o usuário informa login, senha e **WhatsApp válido**. O sistema envia para o celular cadastrado um **código alfanumérico de 10 posições**, pedido no **primeiro login** (2FA de ativação). O código puro nunca é gravado (só SHA-256 com sal do usuário); expira em 10 min e trava após 5 tentativas. Celular mascarado nas respostas e na auditoria. Usuários sem celular cadastrado continuam entrando só com usuário e senha.
**Aceite:**
```gherkin
Dado um usuário cadastrado com WhatsApp e celular ainda não confirmado
Quando ele entra com usuário e senha
Então o sistema envia um código de 10 posições para o WhatsApp cadastrado
E o login só conclui quando o código digitado confere
E após 5 tentativas erradas o código fica travado

Dado um usuário já confirmado
Quando ele entra com usuário e senha
Então o acesso é liberado sem pedir código
```

### RF-037 — Salvar ofertas publicadas nos favoritos do Mercado Livre (Should)
**Ator:** SISTEMA. **Desc:** a cada oferta de ML publicada, adicionar o item na lista de favoritos da conta de afiliado (`POST /users/me/bookmarks`), para ter a vitrine central do que já foi divulgado. Exige access token OAuth (`ML_ACCESS_TOKEN`); sem token, o módulo fica inerte. Falha ao favoritar nunca impede a publicação.
**Aceite:**
```gherkin
Dado um access token OAuth do Mercado Livre configurado
Quando uma oferta de ML é publicada
Então o item é adicionado aos favoritos da conta de afiliado
E se a API recusar, a oferta continua sendo publicada normalmente
```

### RF-033 — Aplicar template padrão do usuário (Should)
**Ator:** SISTEMA. **Desc:** reformatar a mensagem recebida no template Emipe (RN-001) preenchendo título, preços e link transformado; campos não reconhecidos são preservados do texto original.
**Aceite:** mensagem transformada mantém o padrão de bolha WhatsApp (🔥/💵/🎟️/🛒) e o link do usuário.

### RF-034 — Encaminhar para os grupos próprios (Must)
**Ator:** SISTEMA. **Desc:** enviar a mensagem transformada para os grupos de destino configurados, respeitando o ritmo RN-007 e o mesmo `DispatchProvider` do modo automático (`src/wa/dispatch.ts`).
**Aceite:** o log registra origem → destino com `messageId`; limite diário por nº é respeitado.

### RF-035 — Anti-loop e dedup do monitor (Must)
**Ator:** SISTEMA. **Desc:** nunca reencaminhar para o grupo de origem; hash de dedup próprio (MLB/ASIN + link transformado) por 7 dias; mensagem já processada não é reencaminhada.
**Aceite:**
```gherkin
Dado que a mensagem X do grupo monitorado já foi reencaminhada
Quando a mesma mensagem reaparece
Então o sistema marca DUPLICADO_MONITOR e não reenvia
E nenhum envio tem como destino o próprio grupo de origem
```

## 4. Requisitos não-funcionais
- NFR-001 Perf: ingest→preview p95 <15s (sem IA) / <40s (com IA 5 variações).
- NFR-002 Conf: 0 erro silencioso de preço/link (validação Zod + double-check).
- NFR-003 Disp: sessão Evolution reconecta sozinha em <60s; fila persiste em SQLite.
- NFR-004 Seg: segredos só em `.env` (X-API-Key, cookies), nunca em git; rate-limit; allowlist tools IA; Throttle Nest/Express.
- NFR-005 Usab: OP monta oferta com 1 comando + 1 aprovação.
- NFR-006 Portab: Docker Compose up em <5min; `ENGINE_TYPE` trocável.
- NFR-007 Custo: lote 100 msgs documentado; cache evita re-chamada LLM idêntica.
- NFR-008 Compliance: opt-in comprovável; fora janela Cloud só template; piloto ≤50 msgs/dia/nº.

## 5. Regras de negócio
- RN-001 Template oficial (única fonte):
```
*[HEADLINE]*
_[SUBTITULO]_ ‼️

[NOME]

~De R$ [DE]~
*Por R$ [PIX] no Pix*
*Ou R$ [PARC] em até [N]x*

⚠️ Cupom: *[CUPOM]* (omitir bloco se vazio)

🛒 Link do Produto ⤵️
[LINK]
```
Exemplo real (imagem): HEADLINE=`RELÓGIO DE QUALIDADE ABSURDA`, SUB=`caiu muito o preço`, NOME=`Relógio de pulso Orient MBSS1171`, DE=459,99 PIX=233,53 PARC=259,48 N=6 CUPOM=OFERTADEHOJE LINK=`https://meli.la/2aKpCmQ`.
- RN-002 Preço Pix < Parcelado < De, senão bloquear com erro.
- RN-003 Cupom sempre CAIXA ALTA sem espaços.
- RN-004 Link divulgado sempre `final_url` com atribuição + encurtado.
- RN-005 IA nunca altera números/link/cupom, só texto persuasivo.
- RN-006 Lote >1 exige approval; disparo noturno (22h-8h) exige flag explícita.
- RN-007 1 IP dedicado BR por nº Evolution; aquecimento: dia1 ≤20, dia2 ≤35, dia3+ ≤50 msgs.
- RN-008 (Monitor) Domínios aceitos: `mercadolivre.com.br`, `meli.la`, `shopee.com.br`, `shope.ee`, `kabum.com.br`, `amazon.com.br`, `amzn.to`. Fora da allowlist → `NAO_RECONHECIDO`.
- RN-009 (Monitor) Se doc contém vários links, priorizar o primeiro link de programa reconhecido; demais ficam como texto.
- RN-010 (Monitor) Nunca reencaminhar para o grupo de origem; dedup 7d por hash `programa + idProduto + linkTransformado`.
- RN-011 (Monitor) Cada mensagem monitorada só é encaminhada 1x (1 destino primário); fan-out opcional exige flag explícita.
- RN-012 (Monitor) Se o link não puder ser transformado (cookie/tag falha), mensagem vai para fila `REVISAO_MONITOR`, nunca sai sem transformação válida.
- RN-013 (Monitor) O modo monitor e o modo automático compartilham o mesmo contador diário por nº (RN-007) — a soma dos dois não pode exceder o limite do dia.

## 6. Interfaces / Integrações
| Integração | Contrato | Falha |
|---|---|---|
| ML provider (Afilimax/Garimpei) | `POST /extract {url}` → `{titulo,precos,imagem,link}` / `POST /convert-links` | `COOKIE_EXPIRED` → guia refresh; fallback manual |
| Evolution API | `POST /message/sendText+Image {instance,number,media,caption}` + webhook `status` | `CONNECTION_CLOSED` → backoff+QR; fila retém |
| Evolution API (entrada) | Webhook `messages.upsert` → `POST /api/webhook/evolution` (header `X-Webhook-Key`) | payload inválido → 400 e descarta; grupo não monitorado → ignora |
| Cloud API (futuro) | `POST /messages {template|text+image}` Graph | `131047` fora janela → exige template |
| LLM Gateway | `generate({prompt,mode:cheap|smart})` → `{text,cost,ms}` + `trace.json` | fallback template fixo |

## 7. Matriz de rastreabilidade
| RF | RN | US (backlog) | Teste |
|---|---|---|---|
| RF-001,002 | RN-004 | US-01 | E2E extract mock + real 1 URL |
| RF-004,006 | RN-001,002,003 | US-02,03 | Snapshot texto == esperado imagem |
| RF-005 | RN-005 | US-04 | IA não muta números (property test) |
| RF-007 | RN-001 | US-05 | Comparação visual protótipo |
| RF-008,009,010 | RN-006,007 | US-06,07 | Dispatch dry-run + approval obrigatório |
| RF-012,013 | — | US-08 | Health-check simula cookie expirado |
| RF-014 | — | US-09 | PII borrada em import |
| RF-022,023 | — | US-14,15 | Loop qtd=1 vs qtd=2 + jitter de intervalo |
| RF-030,031 | RN-008,009 | US-16,17 | Monitor de grupo + parser ML/Shopee/Kabum/Amazon |
| RF-032 | RN-012 | US-18 | Link transformado usa tag do usuário; nunca cai no perfil |
| RF-033,034 | RN-011,013 | US-19 | Template aplicado + encaminhamento + limite compartilhado |
| RF-035 | RN-010 | US-20 | Anti-loop (origem) + dedup 7d do monitor |

## 8. Riscos e mitigações
| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Ban Evolution | M | Alto | Nº secundário, ritmo RN-007, backup aquecido, migração Cloud mapeada |
| Cookie ML expira | A | M | Health-check + etiquetas reserva + fallback manual |
| Baileys quebra pós-update Meta | M | M | Pinar versão, monitorar releases, provider abstraído |
| Mudança preço Cloud 01/10/2026 | A | M | Recalcular antes Sprint 3, cache + janela 24h |
| Alucinação IA em preço | B | Alto | RN-005 + Zod + teste propriedade + approval |
| Vazamento telefone print | M | Alto | RF-014 + `.env` + SAST kalimaster |

## 9. Glossário
Tag/etiqueta, `meli.la`, HSM/template, janela 24h, Baileys, Evolution, WABA, approval gate, trace, opt-in.

---
*Checklist skill: IDs sequenciais ✓ MoSCoW ✓ Gherkin por RF ✓ NFRs quantificados ✓ matriz ✓.*
