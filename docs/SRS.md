# SRS — Software Requirements Specification — autoMensagemWhats

> Versão 0.1 | 2026-10-12 | Branch `develop` | Stack alvo: Node 20+ ESM + TypeScript + Evolution API + Afilimax/Garimpei + EngAI Gateway
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
Selecionar grupo opt-in, agendar, enviar imagem+legenda, registrar messageId/status.

### RF-011 — Histórico e reenvio (Should)
Listar ofertas, status, messageId, reenviar/editar copy.

### RF-012 — Health-check cookie/sessão (Should)
Job diário valida cookie ML e sessão Evolution, alerta em log/`/stats`.

### RF-013 — Observabilidade (Should)
`/stats`, `trace.json` (modelo, tokens, R$, ms), logs estruturados pino.

### RF-014 — Anonimizar PII de prints (Must, LGPD)
Borrar telefones/nomes ao importar screenshot para treino/template mining.

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

## 6. Interfaces / Integrações
| Integração | Contrato | Falha |
|---|---|---|
| ML provider (Afilimax/Garimpei) | `POST /extract {url}` → `{titulo,precos,imagem,link}` / `POST /convert-links` | `COOKIE_EXPIRED` → guia refresh; fallback manual |
| Evolution API | `POST /message/sendText+Image {instance,number,media,caption}` + webhook `status` | `CONNECTION_CLOSED` → backoff+QR; fila retém |
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
