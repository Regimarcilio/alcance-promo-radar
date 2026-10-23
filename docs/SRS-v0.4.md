# SRS — Alcance — v0.4

> **Versão:** 0.4 · **Data:** 2026-10-22 · **Branch:** `develop` · **Commit de referência:** `98c4483`
> **Produto:** Alcance (nome técnico legado do pacote: `automensagemwhats`) · **Versão do pacote:** `0.8.0`
> **Stack real:** Node.js ≥ 20 · TypeScript ESM (`NodeNext`) · Evolution API v2.3.7 (Baileys) · Docker Compose
> **Persistência real:** arquivos JSON atômicos em `data/` (não há SQLite nem banco próprio)
> **Substitui:** `docs/SRS.md` v0.3 (2026-10-17) e `docs/SRS-v0.2-delta.md` (2026-10-12)

Este documento consolida o SRS v0.3 + delta v0.2 e o que foi efetivamente entregue até o commit
`98c4483`. Ele descreve **o produto que existe no código**, não o produto planejado em 2026-10-12.
Requisitos que não existem foram marcados como `ADIADO`, `REMOVIDO` ou `NÃO IMPLEMENTADO`.

---

## 1. Introdução

### 1.1 Propósito

Especificar o Alcance: um operador de afiliados monitora grupos de WhatsApp, identifica ofertas de
Mercado Livre, Amazon e Shopee, troca o link pelo seu link de afiliado e reencaminha para os próprios
grupos; além disso, pode operar um Piloto automático por categoria, sincronizar contatos, disparar
campanhas e administrar múltiplos números de envio por um painel autenticado.

### 1.2 Escopo

**IN (implementado ou em operação):**

- Monitor por webhook da Evolution API, com regras origem → destinos, parser, transformação de link,
  template, mídia, fila anti-rajada, dedup e revisão.
- Piloto automático multi-loop (até 5 loops), com categorias do Mercado Livre, palavra-chave,
  subcategoria, cesta manual, Amazon e cupons.
- Multi-número: até 5 instâncias, peso, QR, envio por todos os abertos e fallback.
- Clientes: sincronização de participantes de grupos, listas, campanha em fila e adição em gotejamento.
- Painel web com login, sessão, 2FA por WhatsApp no primeiro acesso, 6 temas, títulos editáveis e
  rastreio de publicações.
- Integrações Mercado Livre, Amazon (Creators API/CDN), Shopee (Open API) e Evolution v2/GO.
- Persistência em JSON: `data/*.json`, mídia em `data/midia/`, logs em `logs/`.

**OUT (não implementado ou fora do escopo atual):**

- WhatsApp Cloud API oficial (`CloudProvider` não existe no código).
- SQLite, Postgres próprio, ORM ou migrations do Alcance.
- Afilimax/Garimpei, BotDoAfiliado ou provedor externo de extração de ofertas.
- Modelo de IA pago, RAG, embeddings, fine-tuning ou gateway EngAI com roteamento/cache semântico.
- Multiusuário com papéis na UI, multitenancy, cobrança/SaaS.
- Importação de prints com anonimização de PII (não há fluxo de screenshot).
- Envio de mensagens temporárias (`ephemeralMessage`) pelo Alcance.
- TLS/reverse proxy nativo, container non-root e backup automatizado (pendências de operação).

### 1.3 Definições

| Termo | Definição |
|---|---|
| Alcance | Produto/painel; marca usada na interface. `automensagemwhats` é o nome técnico legado. |
| Monitor | Fluxo que recebe mensagens de grupos de origem via webhook e reencaminha ofertas. |
| Origem | Grupo de WhatsApp monitorado (`...@g.us`) de onde a oferta é lida. |
| Destino | Grupo próprio que recebe a oferta transformada. Cada origem tem seus destinos. |
| JID | Identificador do WhatsApp (`telefone@s.whatsapp.net` ou `grupo@g.us`). |
| Transformação | Troca do link original pelo link de afiliado do operador. |
| Revisão | Estado em que a oferta não é enviada automaticamente (link inválido, sem destino, envio direto desligado etc.). |
| Rajada | Quarta mensagem da mesma origem no intervalo de 1 minuto; a partir dela o envio entra na fila. |
| Dedup | Bloqueio de repetição por hash de programa + produto (ou link) por janela configurável. |
| Rotação | Sorteio ponderado do número remetente entre instâncias ativas. |
| Principal | Instância reservada a operações de serviço (adicionar contatos, permissões). |
| Secundário | Instância adicional; participa do envio junto com o principal, conforme o peso. |
| Piloto | Loop automático que caça ofertas por categoria e publica em um grupo. |
| Stub de IA | Gateway local determinístico que gera headline por template, sem LLM e com custo 0. |
| 2FA de ativação | Código alfanumérico de 10 posições enviado por WhatsApp no primeiro login. |
| Rastreio | Registro do que foi publicado (`data/publicacoes.json`) para reconciliar com o programa de afiliados. |

### 1.4 Referências

- Código: `src/manager/`, `src/monitor/`, `src/wa/`, `src/clientes/`, `src/ml/`, `src/store/`, `src/ai/`, `src/ui/`.
- Autenticação: `docs/13-auth-spec.md`, `src/manager/auth.ts`, `src/manager/verificacao.ts`, ADR-005.
- Estado real: `docs/14-relatorio-geral.md` (retrato histórico de 2026-10-21) e `docs/dev-log.md`.
- Decisões: `docs/04-ADRs/ADR-001` a `ADR-010`.
- Configuração: `.env.example`.
- Template: `docs/11-padrao-emipe.md` e `src/wa/formatter.ts`.
- Curso de referência: https://integrador-cedup.glide.page/dl/a400f7.

### 1.5 O que foi removido deste SRS

| Item do SRS v0.3 / delta | Situação na v0.4 |
|---|---|
| SQLite como persistência (NFR-003, RF-021) | **Removido.** O produto usa JSON em `data/`; não há SQLite. |
| Afilimax/Garimpei/BotDoAfiliado (RF-002, ADR-003) | **Removido do escopo.** O ML é acessado por endpoint interno do afiliado e pela página do item (`src/ml/provider.ts`, `src/ml/item-page.ts`). |
| `CloudProvider` (RF-009, ADR-001) | **Não implementado.** Existe a abstração de dispatch e o provider Evolution v2 + GO; Cloud é possibilidade futura. |
| EngAI Gateway com router/cache/RAG/guardrails (RF-005, ADR-002) | **Não implementado como gateway de IA.** O que existe é um stub local determinístico em `src/ai/gateway.ts`, custo 0. |
| Aprovação obrigatória para todo lote > 1 (RF-008/RN-006) | **Não vigente no Piloto/Monitor.** Existe fila de aprovação apenas no CLI legado (`src/jobs/auto.ts`, `fila:approve`). |
| Limite diário de mensagens por número (RN-007/RN-013) | **Removido.** O Piloto não tem limite diário; a janela 8h–23h e o dedup continuam. |
| Anonimização de PII de prints (RF-014) | **Removido do escopo.** Não há importação de screenshot no produto atual. |
| Histórico de preços em SQLite (RF-021) | **Não implementado.** O scorer usa os dados atuais da fonte, sem série histórica. |

---

## 2. Descrição geral

### 2.1 Perspectiva do produto

O Alcance é um processo Node único que sobe um servidor HTTP (`src/manager/server.ts`) e workers em
memória. O painel HTML/CSS/JS é servido pelo próprio processo. O estado é lido/gravado em JSON
atômico (`tmp` + `rename`) em `data/`. A Evolution API é o único transporte de WhatsApp; o Alcance
não fala com o WhatsApp diretamente.

Fluxos principais:

```
Evolution (webhook messages.upsert)
  -> src/monitor/webhook.ts
  -> parser (src/monitor/parser.ts)
  -> transformer (src/monitor/transformer.ts)
  -> dedup (src/monitor/state.ts)
  -> template (src/wa/formatter.ts)
  -> fila anti-rajada (src/monitor/fila.ts)
  -> dispatch (src/wa/dispatch.ts)
  -> rotação de números (src/wa/rotacao.ts)
  -> Evolution sendText/sendMedia
```

```
Piloto (src/ml/piloto.ts)
  -> hunt (src/hunter/service.ts) ou Amazon (src/amazon/amazon.ts)
  -> scorer (src/scorer.ts)
  -> conversor de link (src/ml/provider.ts)
  -> cupons (src/ml/cupons.ts)
  -> formatter (src/wa/formatter.ts)
  -> dispatch (src/wa/dispatch.ts)
  -> rastreio (src/store/publicacoes.ts)
```

### 2.2 Usuários

| Ator | Descrição | Necessidades |
|---|---|---|
| Operador (OP) | Afiliado que opera o painel | Login seguro, monitorar grupos, iniciar/parar Piloto, gerenciar números, clientes e cupons. |
| Administrador (ADM) | Responsável pela instalação/credenciais | Criar credencial, configurar `.env`, Evolution, tags, cookies e tokens. |
| SISTEMA | Processo Node e workers | Webhook, fila, dedup, rotação, retries, persistência e logs. |

### 2.3 Restrições

- **R1:** Node.js ≥ 20; TypeScript ESM (`"type": "module"`, `NodeNext`).
- **R2:** Evolution API v2.3.7 ou Evolution GO; a sessão WhatsApp é acoplada à instância.
- **R3:** o cookie/tag do Mercado Livre pode expirar; sem conversão válida a oferta vai para revisão.
- **R4:** Amazon Creators e Shopee Open API dependem de credenciais externas e aprovação.
- **R5:** segredos ficam em `.env` e `data/`, nunca no Git.
- **R6:** o painel não deve ser exposto fora de loopback sem TLS/reverse proxy.
- **R7:** o processo é single-node; sessões de login ficam em memória e caem no restart.
- **R8:** não há banco próprio; consistência depende de escrita atômica de JSON e de um único processo.

### 2.4 Premissas

- O operador tem grupos próprios com opt-in e autorização para publicar.
- A Evolution está pareada e com webhook apontando para `/api/webhook/evolution`.
- O operador possui tag ML e, para Amazon/Shopee, as credenciais do programa.
- O host tem Docker/Compose e volume persistente para `data/` e `logs/`.

### 2.5 Persistência (fonte de verdade)

| Arquivo | Conteúdo | Módulo |
|---|---|---|
| `data/auth-users.json` | Usuários, hash scrypt, telefone, estado da verificação | `src/manager/auth.ts`, `verificacao.ts` |
| `data/auth-audit.log` | Auditoria JSONL sem senha/hash/cookie | `src/manager/auth.ts` |
| `data/instancias.json` | Números, peso, ativo, principal, envios | `src/wa/rotacao.ts` |
| `data/clientes.json` | Contatos e listas | `src/clientes/clientes.ts` |
| `data/clientes-fila.json` | Campanha em andamento | `src/clientes/clientes.ts` |
| `data/monitor.json` | Regras origem → destinos, autoEnviar, fonte da foto | `src/monitor/grupos.ts` |
| `data/monitor-estado.json` | Hashes de dedup e eventos | `src/monitor/state.ts` |
| `data/monitor-fila.json` | Fila anti-rajada persistida | `src/monitor/fila.ts` |
| `data/envios.json` | Dedup do Piloto/CLI | `src/store/dedup.ts` |
| `data/publicacoes.json` | Rastreio do que foi publicado | `src/store/publicacoes.ts` |
| `data/cestas.json` | Cestas manuais por categoria | `src/ml/piloto.ts` |
| `data/piloto.json` | Loops, presets e logs do Piloto | `src/ml/piloto.ts` |
| `data/contas.json` | Contas ML, tags mascaradas e mapa categoria → grupo | `src/ml/contas.ts` |
| `data/cupons.json` | Cupons/códigos por categoria/conta | `src/ml/cupons.ts` |
| `data/ui.json` | Títulos editáveis dos cards | `src/ui/titulos.ts` |
| `data/midia/` | Fotos recebidas, com retenção de 3 dias | `src/monitor/midia.ts` |

---

## 3. Requisitos funcionais

Legenda de status: **Implementado** · **Implementado parcial** · **Adiado** · **Removido** ·
**Não implementado**.

### 3.1 Autenticação e painel

#### RF-040 — Login, sessão e default-deny (Must · Implementado)

**Ator:** OP/ADM. **Descrição:** autenticar com usuário e senha (scrypt), criar sessão assinada por
HMAC em cookie `alcance_sid` (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` opcional), aplicar
TTL absoluto (`AUTH_TTL_HORAS=8`) e idle (`AUTH_IDLE_MIN=30`), limitar a 5 sessões por usuário e
negar por padrão `GET /` e `/api/*` sem sessão (exceto `/login` e o webhook).
**Código:** `src/manager/auth.ts`, `src/manager/server.ts`, `src/manager/login.html`.
**Teste:** `src/manager/auth.test.ts` (7 testes).
**Aceite:** sem sessão, `GET /` responde 302 para `/login`; `GET /api/piloto` responde 401;
credencial correta cria cookie e libera o painel; assinatura adulterada é rejeitada.
**Dependências:** `SESSION_SECRET` com ≥ 32 caracteres; usuário ativo em `data/auth-users.json`.

#### RF-036 — Verificação de celular por WhatsApp no primeiro acesso (Must · Implementado)

**Ator:** SISTEMA/OP. **Descrição:** no cadastro via `scripts/auth-user.mjs`, exigir `--telefone`
(ou `AUTH_TELEFONE`), normalizar DDI, gerar código alfanumérico de 10 posições (alfabeto sem
`0/O/1/I`), enviar pela Evolution e pedir o código no primeiro login. O código puro não é gravado;
só SHA-256 com sal do usuário. Expira em 10 min e trava após 5 tentativas. O telefone é mascarado
nas respostas e na auditoria. Usuário sem telefone continua entrando só com usuário e senha.
**Código:** `src/manager/verificacao.ts`, `src/manager/auth.ts`, `src/manager/server.ts`,
`scripts/auth-user.mjs`.
**Teste:** `src/manager/verificacao.test.ts` (8 testes) e `auth.test.ts`.
**Aceite:** primeiro login com celular pendente devolve `{precisaCodigo:true, telefone:"55•••9999"}`;
código correto ativa; código errado conta tentativa; 5 erros travam; código expirado é recusado.
**Dependências:** Evolution no ar para o envio; `EVO_URL`/`EVO_KEY`/`EVO_INSTANCE`.

#### RF-041 — Rate-limit, auditoria e headers de segurança (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** limitar login a 5 tentativas/min por IP (bloqueio de 60 s) e
30/min global; auditar eventos em `data/auth-audit.log` com IP mascarado /24, sem PII; enviar
CSP, COOP, CORP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` e `X-Robots-Tag`; validar
`Origin` em métodos não-GET (exceto webhook).
**Código:** `src/manager/auth.ts`, `src/manager/server.ts`.
**Teste:** `src/manager/auth.test.ts` (rate-limit e auditoria).
**Aceite:** 6ª tentativa em 1 min recebe 429 com `Retry-After`; log contém `ip` mascarado e não
contém senha, hash ou cookie; respostas carregam os headers.
**Dependências:** RF-040.

### 3.2 Piloto automático e ofertas

#### RF-001 — Cadastrar oferta por URL (Removido)

**Ator:** OP. **Descrição original:** aceitar URL ML e criar rascunho. **Situação:** não há cadastro
de oferta por URL no painel. A entrada atual é por categoria/palavra-chave (RF-015/016), cesta
manual (RF-003) ou envio direto (`POST /api/enviar-direto`). **Código relacionado:** `src/cli.ts`
(`cesta:importar`, `hunter:buscar`), `src/ml/piloto.ts`. **Teste:** não há. **Substituído por:** RF-003,
RF-015 e RF-016.

#### RF-002 — Enriquecer dados do produto no Mercado Livre (Must · Implementado parcial)

**Ator:** SISTEMA. **Descrição:** obter link de afiliado e dados do anúncio via endpoint interno do
ML (`converterLink`) e página do item (`resolverProdutoML`/`completarCandidato`), com tag/cookie do
operador. Não há Afilimax/Garimpei. **Código:** `src/ml/provider.ts`, `src/ml/item-page.ts`,
`src/monitor/produto.ts`, `src/ml/contas.ts`. **Teste:** `src/monitor/transformer.test.ts` cobre
Shopee/KaBuM; o caminho ML não tem teste automatizado. **Aceite:** link convertido usa a tag do
operador; falha devolve `ok:false` e motivo, sem inventar link. **Dependências:** `TAG_ML`,
`COOKIE_ML`, conta ML ativa.

#### RF-003 — Cesta manual e envio direto (Should · Implementado)

**Ator:** OP. **Descrição:** abastecer uma cesta por categoria com `URL | pix | de | titulo | foto`
via `cesta:importar` e enviar oferta colada/confirmada pela UI (`POST /api/enviar-direto`).
**Código:** `src/ml/piloto.ts`, `src/cli.ts`, `src/manager/server.ts`. **Teste:** não há teste
automatizado da cesta. **Aceite:** item importado aparece na cesta da categoria; envio direto exige
`titulo`, `precoPix` e `link`, aceita `dry` e devolve a mensagem gerada. **Dependências:** RF-004.

#### RF-004 — Template de mensagem RN-001 v3 (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** montar a mensagem com marca opcional, título com `🔥`, linha
opcional de Pix, `De/Por/parcelas`, frete opcional, cupom opcional, bloco `🛒 Link do Produto ⤵️` e
link. O template real é `src/wa/formatter.ts`; ver `docs/11-padrao-emipe.md`.
**Código:** `src/wa/formatter.ts`. **Teste:** não há teste dedicado do formatter (há teste de
sintaxe do painel, não do texto). **Aceite:** mensagem gerada tem os blocos acima; omite blocos
opcionais vazios; lança `MENSAGEM_LONGA` acima de 4096 caracteres.
**Dependências:** RN-001, RN-002, RN-003.

#### RF-005 — Variações de copy com IA (Should · Adiado)

**Ator:** SISTEMA. **Descrição:** gerar 5 headlines únicas via LLM, com custo/latência em trace.
**Situação real:** `src/ai/gateway.ts` é um stub determinístico com 3 headlines de template
(`QUALIDADE ABSURDA`, `ACHADINHO...`, `DESCONTO INSANO`), grava `data/trace.json` com
`modelo:"template-local-v1"` e `custoBRL:0`. Não há chamada de LLM, router, cache semântico, RAG ou
guardrail. **Código:** `src/ai/gateway.ts`. **Teste:** não há.
**Aceite atual:** `gerarHeadline` devolve headline/subtítulo e trace sem tocar a rede.
**Pendência:** integração real de IA permanece adiada até haver modelo/credencial e avaliação.

#### RF-006 — Formatar para WhatsApp (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** usar a sintaxe do WhatsApp (`*negrito*`, `~riscado~`), emojis do
template e limite de 4096 caracteres. **Código:** `src/wa/formatter.ts`. **Teste:** não há teste
dedicado. **Aceite:** mensagem de exemplo do RN-001 é reproduzida; texto acima de 4096 lança erro
tratado pelo chamador. **Dependências:** RF-004.

#### RF-007 — Preview fiel da mensagem (Must · Histórico/Parcial)

**Ator:** OP. **Descrição original:** exibir bolha idêntica ao WhatsApp antes do envio.
**Situação:** existiu protótipo em `docs/prototipo/index.html` e `docs/07-prototipo-resultado.md`;
o painel atual devolve a mensagem em `/api/enviar-direto` e a envia, mas não há tela de preview fiel
com foto/hora/check. **Código:** `src/manager/server.ts` (`/api/enviar-direto`). **Teste:** não há.
**Status:** parcial/histórico; não é gate de envio.

#### RF-008 — Approval gate para lote (Must · Implementado parcial/legado)

**Ator:** OP/ADM. **Descrição original:** nenhum lote > 1 sai sem aprovação explícita.
**Situação:** o CLI legado `src/jobs/auto.ts` enfileira em `data/fila.json` quando
`MODO != AUTO` ou `AUTO_APROVADO != true`, e `fila:approve` envia. O Piloto e o Monitor **não**
usam esse gate: o Piloto publica no ciclo e o Monitor publica quando `autoEnviar=true`.
**Código:** `src/jobs/auto.ts`, `src/cli.ts`. **Teste:** não há.
**Aceite (legado):** `runAuto` em modo REVISÃO não envia; `fila:approve <MLB> --live` envia.
**Decisão registrada:** não é requisito vigente do fluxo principal.

#### RF-009 — Envio por provider abstraído (Must · Implementado parcial)

**Ator:** SISTEMA. **Descrição:** `enviarParaGrupo`/`enviarMidia` roteiam entre Evolution v2 e
Evolution GO (`EVO_ENGINE`), com retry de erros transitórios (3 tentativas, 2 s/4 s) e re-sorteio de
número. **Código:** `src/wa/dispatch.ts`, `src/wa/evolution-go.ts`, `src/wa/rotacao.ts`.
**Teste:** `src/wa/rotacao.test.ts` cobre rotação; dispatch não tem teste dedicado.
**Aceite:** falha transitória (`5xx`, `Connection Closed`, timeout) é repetida; falha permanente
sobe; cada tentativa usa `proximaInstancia()`. **Nota:** `CloudProvider` não existe.

#### RF-010 — Agendar e enviar no grupo piloto (Must · Implementado)

**Ator:** OP. **Descrição:** iniciar/parar loops por categoria, com grupo, conta, filtro,
subcategoria, quantidade por ciclo e intervalo. O Piloto roda ciclo de 5 min, pausa de 8 min a cada
55 min de trabalho e pausa noturna 23h–8h (configurável). **Código:** `src/ml/piloto.ts`.
**Teste:** `src/ml/piloto.test.ts` (2 testes de retomada no boot). **Aceite:** loop ativo publica
ofertas com link convertido e registra `messageId`; loop parado não agenda timer.
**Dependências:** RF-002, RF-004, RF-009.

#### RF-011 — Histórico e reenvio (Should · Implementado parcial)

**Ator:** OP. **Descrição:** registrar publicações e permitir conferência por programa/categoria/
grupo/período, com CSV. Reenvio manual não é oferecido. **Código:** `src/store/publicacoes.ts`,
`src/manager/server.ts` (`/api/rastreio`). **Teste:** `src/store/publicacoes.test.ts` (4 testes).
**Aceite:** publicação é registrada com link exato, programa, grupo e `via`; filtros e CSV
funcionam. **Pendência:** reenvio/edição de copy.

#### RF-012 — Health-check de cookie/sessão (Should · Adiado)

**Ator:** SISTEMA. **Descrição original:** job diário validando cookie ML e sessão Evolution com
alerta. **Situação:** não existe job de health-check. Há consulta de estado da instância
(`estadoInstancia`) e exibição no painel, mas sem alerta/agendamento. **Código relacionado:**
`src/wa/rotacao.ts`, `src/monitor/evolution.ts`. **Teste:** não há.
**Status:** adiado. **Aceite futuro:** job diário registra estado e sinaliza cookie/sessão inválidos.

#### RF-013 — Observabilidade (Should · Implementado parcial)

**Ator:** SISTEMA/OP. **Descrição original:** `/stats`, trace de IA e logs estruturados.
**Situação:** não há `/stats` nem métricas Prometheus. Há logs em `logs/` (Piloto, um arquivo por
dia), eventos do monitor em `data/monitor-estado.json`, auditoria de auth e trace do stub de IA.
**Código:** `src/ml/piloto.ts`, `src/monitor/state.ts`, `src/manager/auth.ts`, `src/ai/gateway.ts`.
**Teste:** `src/monitor/state.test.ts` cobre limite de eventos. **Status:** parcial.

#### RF-014 — Anonimizar PII de prints (Must · Removido)

**Ator:** SISTEMA. **Descrição original:** borrar telefones/nomes ao importar screenshot.
**Situação:** o produto não importa prints; o fluxo de mídia é a foto da oferta recebida pelo
webhook (`src/monitor/midia.ts`), não screenshot de conversa. **Status:** removido do escopo.
**Teste:** não há.

#### RF-015 — Categoria, subcategoria e filtros (Must · Implementado)

**Ator:** OP. **Descrição:** escolher categoria ML, subcategoria, palavra-chave, quantidade e
intervalo no início do loop; o Piloto usa esses filtros na caça. **Código:** `src/ml/piloto.ts`,
`src/categorias.json`, `src/manager/server.ts`. **Teste:** não há teste de UI; lógica de loop tem
teste de boot. **Aceite:** `start` cria loop com `category`, `sub`, `filtro`, `qtd` e `intervaloS`
normalizados (qtd 1/2; intervalo 45–90). **Dependências:** RF-016.

#### RF-016 — Caçar oportunidades na categoria (Must · Implementado parcial)

**Ator:** SISTEMA. **Descrição:** buscar ofertas em níveis: hub de afiliados, API pública de search,
página de busca e mock de piloto (badge DEMO); enriquecer o Top 8. **Código:**
`src/hunter/service.ts`, `src/ml/hub.ts`, `src/ml/search-page.ts`, `src/ml/item-page.ts`.
**Teste:** não há teste do hunter; `src/monitor/transformer.test.ts` cobre transformação.
**Aceite:** retorna candidatos com id, título, preços, imagem e link; se todas as fontes falham,
retorna mock sinalizado (`mock:true`). **Pendência:** sem API oficial de afiliados ML.

#### RF-017 — Rankear por score explicável (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** calcular score com pesos `desconto 0.6`, `cupom 0.15`,
`vendidos 0.15`, `avaliação 0.1` e devolver motivo/selo (`QUEDA REAL`/`OFERTA BOA`).
**Código:** `src/scorer.ts`. **Teste:** não há teste dedicado.
**Aceite:** mesmo candidato gera mesmo score/motivo; `rankear` aplica corte e desconto mínimo.
**Nota:** a fórmula do SRS v0.3 (0.5/0.2/0.15/0.1/0.05) não é a implementada.

#### RF-018 — Modo AUTO vs REVISÃO (Must · Implementado parcial/legado)

**Ator:** ADM. **Descrição original:** AUTO publica sozinho; REVISÃO exige aprovação.
**Situação:** o CLI `runAuto` implementa `MODO=AUTO` + `AUTO_APROVADO=true`; o Piloto é contínuo e
não tem aprovação por oferta. O Monitor tem `autoEnviar` (liga/desliga envio direto).
**Código:** `src/jobs/auto.ts`, `src/ml/piloto.ts`, `src/monitor/grupos.ts`. **Teste:** não há.
**Aceite (legado):** em REVISÃO, item vai para `data/fila.json`; em AUTO com `--live`, envia.
**Decisão:** o gate não é requisito do Piloto/Monitor atuais.

#### RF-019 — Anti-duplicidade do Piloto/CLI (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** bloquear o mesmo `MLB/ASIN` com mesmo preço e cupom por 7 dias
(configurável por `dias`), usando `data/envios.json`. **Código:** `src/store/dedup.ts`.
**Teste:** indiretamente em `src/wa/rotacao.test.ts` (dedup do monitor); o dedup do Piloto não tem
teste dedicado. **Aceite:** `jaEnviado` retorna true dentro da janela; `registrarEnvio` grava dia
local de São Paulo. **Dependências:** RF-010.

#### RF-020 — Janela, scheduler e kill-switch (Must · Implementado parcial)

**Ator:** ADM. **Descrição original:** cron 2h, janela 8h–22h, limite diário e `AUTO_OFF`.
**Situação:** janela real `JANELA_INICIO=8` / `JANELA_FIM=23` (default no código e no `.env`);
**não há limite diário**; o Piloto agenda timers em memória (5 min/8 min) e o CLI usa cron externo;
`data/AUTO_OFF` funciona apenas no CLI `runAuto`. **Código:** `src/ml/piloto.ts`, `src/jobs/auto.ts`.
**Teste:** `src/ml/piloto.test.ts` cobre retomada, não a janela. **Status:** parcial.
**Aceite:** fora da janela o Piloto não publica e agenda o retorno; `AUTO_OFF` impede o CLI.

#### RF-021 — Histórico de preços (Should · Adiado)

**Ator:** SISTEMA. **Descrição original:** guardar série para provar queda real.
**Situação:** não há histórico; o scorer não compara com preço anterior. **Código relacionado:**
`src/scorer.ts`. **Teste:** não há. **Status:** adiado.

#### RF-022 — Quantidade de postagens por ciclo (Should · Implementado)

**Ator:** OP. **Descrição:** `qtd ∈ {1,2}` por ciclo; default 2. **Código:** `src/ml/piloto.ts`.
**Teste:** não há teste dedicado. **Aceite:** `qtd=1` publica uma; `qtd=2` publica até duas com
intervalo entre elas. **Dependências:** RF-023.

#### RF-023 — Intervalo humano entre postagens do ciclo (Should · Implementado)

**Ator:** SISTEMA. **Descrição:** intervalo de 45–90 s (default 60 s) com jitter de ±10 s entre as
duas mensagens do ciclo. **Código:** `src/ml/piloto.ts` (`gapS`, `esperar`). **Teste:** não há.
**Aceite:** segundo envio ocorre após o gap; valores fora da faixa são normalizados para 45–90.

### 3.3 Monitor

#### RF-030 — Monitorar grupos de afiliados (Must · Implementado)

**Ator:** OP. **Descrição:** cadastrar até 10 origens, cada uma com até 10 destinos; receber
`messages.upsert` no webhook `POST /api/webhook/evolution` com `X-Webhook-Key`; ignorar grupos não
monitorados e mensagens próprias. **Código:** `src/monitor/grupos.ts`, `src/monitor/webhook.ts`,
`src/manager/server.ts`. **Teste:** `src/monitor/parser.test.ts` cobre classificação; grupos não têm
teste dedicado. **Aceite:** origem ativa com destino recebe a oferta; origem desconhecida é
`IGNORADO`; mensagem `fromMe` é ignorada. **Dependências:** RF-031, RF-032, RF-034.

#### RF-031 — Identificar oferta e programa (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** detectar URLs, classificar por allowlist (ML, Shopee, KaBuM,
Amazon), extrair MLB/ASIN/id Shopee/KaBuM e escolher o primeiro link reconhecido. Expandir
encurtadores (`meli.la`, `amzn.to`, `tidd.ly` e redirects) e domínio próprio da origem.
**Código:** `src/monitor/parser.ts`, `src/monitor/curtos.ts`. **Teste:** `src/monitor/parser.test.ts`
(6) e `src/monitor/curtos.test.ts` (9). **Aceite:** link ML vira `mercadolivre` com MLB; Amazon com
ASIN; Shopee com shop/item; domínio fora da allowlist gera `desconhecido`; sem link reconhecido vai
para revisão. **Dependências:** RN-008, RN-009.

#### RF-032 — Transformar link para o link do operador (Must · Implementado parcial)

**Ator:** SISTEMA. **Descrição:** ML via `converterLink` (tag/cookie); Shopee via Open API
`generateShortLink` com assinatura SHA-256; Amazon via `tag`; KaBuM via `KABUM_REF`. Nunca inventar
link. **Código:** `src/monitor/transformer.ts`, `src/monitor/shopee-api.ts`, `src/ml/provider.ts`,
`src/monitor/amazon-api.ts`. **Teste:** `src/monitor/shopee-api.test.ts` (10),
`src/monitor/transformer.test.ts` (5), `src/monitor/amazon-api.test.ts` (6).
**Aceite:** ML usa a tag do operador; Shopee devolve `shope.ee`; sem credencial/falha mantém a URL
original e `ok:false`; `smtt` legado não conta como afiliado. **Dependências:** `TAG_ML`,
`COOKIE_ML`, `SHOPEE_APP_ID/SECRET`, `AMAZON_TAG`, `KABUM_REF`.

#### RF-033 — Aplicar template ao repasse (Should · Implementado)

**Ator:** SISTEMA. **Descrição:** quando há título e preço do anúncio, montar pelo template RN-001
v3; caso contrário preservar o texto original e trocar o link, com bloco de link no fim.
**Código:** `src/monitor/webhook.ts` (`montarRepasse`), `src/wa/formatter.ts`.
**Teste:** não há teste de `montarRepasse`. **Aceite:** repasse tem título/preço/link do operador;
sem dados usa texto limpo + link; acima de 4096 é truncado no fallback.
**Dependências:** RF-004, RF-032.

#### RF-034 — Encaminhar para os grupos próprios (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** enviar para todos os destinos ativos da origem, com foto da
origem (padrão) ou do anúncio (`foto:"produto"`), usando o dispatch e a rotação; registrar
`messageId`/evento. **Código:** `src/monitor/webhook.ts`, `src/monitor/grupos.ts`,
`src/wa/dispatch.ts`, `src/monitor/midia.ts`. **Teste:** `src/monitor/transformer.test.ts` e
`src/monitor/evolution.test.ts` (12) cobrem partes. **Aceite:** todos os destinos recebem; foto da
origem tem prioridade; falha transitória volta para a fila (RF-043).

#### RF-035 — Anti-loop, dedup e revisão (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** nunca enviar para a origem; dedup por hash de programa + id do
produto (ou link) por `DEDUP_DIAS` (default 7), com `DEDUP_POR_ORIGEM=1` para permitir o mesmo
produto de origens diferentes; link não transformado vai para `REVISAO`; sem destino/autoEnviar
desligado também vai para revisão. **Código:** `src/monitor/state.ts`, `src/monitor/webhook.ts`.
**Teste:** `src/wa/rotacao.test.ts` (3 testes de dedup) e `src/monitor/state.test.ts` (3).
**Aceite:** reenvio do mesmo produto é `DUPLICADO`; destino nunca é a origem; falha de transformação
é `REVISAO`. **Dependências:** RF-030, RF-032.

#### RF-037 — Favoritos do Mercado Livre (Should · Implementado)

**Ator:** SISTEMA. **Descrição:** ao publicar oferta ML no Piloto, adicionar o item em
`POST /users/me/bookmarks`; sem `ML_ACCESS_TOKEN` o módulo é inerte; falha nunca derruba a
publicação. **Código:** `src/ml/favoritos.ts`, `src/ml/piloto.ts`.
**Teste:** `src/ml/favoritos.test.ts` (5). **Aceite:** com token, POST com `item_id`; sem token,
nenhuma chamada; erro é registrado e o fluxo continua. **Dependências:** `ML_ACCESS_TOKEN`.

#### RF-043 — Fila anti-rajada do monitor (Must · Implementado)

**Ator:** SISTEMA. **Descrição:** a partir da 4ª mensagem da mesma origem no último minuto, enfileirar
e liberar um item a cada `MONITOR_FILA_INTERVALO_S` (default 120 s), persistindo em
`data/monitor-fila.json`; item que falha em envio transitório volta à fila com os destinos restantes.
**Código:** `src/monitor/fila.ts`, `src/monitor/webhook.ts`.
**Teste:** `src/monitor/fila.test.ts` (3). **Aceite:** até 3 mensagens/min seguem direto; da 4ª em
diante ficam `ENFILEIRADA`; reenfileirar não duplica e preserva destinos restantes.
**Nota:** comentários antigos no código chamam esta fila de "RF-036"; a numeração canônica é RF-043.

#### RF-044 — Mensagens temporárias de 7 dias no destino (Should · Não implementado)

**Ator:** OP. **Descrição original:** enviar o repasse como `ephemeralMessage` de 7 dias.
**Situação:** o código apenas **desembrulha** mensagens temporárias recebidas
(`src/monitor/webhook.ts`); o envio não configura ephemeral. A afirmação do relatório de 2026-10-21
não corresponde ao código atual. **Código relacionado:** `src/monitor/webhook.ts`,
`src/wa/dispatch.ts`. **Teste:** não há. **Status:** não implementado/planejado.

#### RF-053 — Permissões de grupo (Should · Implementado)

**Ator:** OP. **Descrição:** consultar e alterar permissão de grupo (`announcement`/`not_announcement`
e `locked`/`unlocked`) via Evolution, exigindo conta admin. **Código:** `src/monitor/evolution.ts`,
`src/manager/server.ts`. **Teste:** `src/monitor/evolution.test.ts` (4 testes de permissão).
**Aceite:** 403 da Evolution retorna aviso de que a conta precisa ser admin; grupo inválido não toca
a rede. **Dependências:** Evolution pareada.

#### RF-054 — QR, reinício e desconexão de instância (Should · Implementado)

**Ator:** OP. **Descrição:** listar instâncias, obter QR, ativar/desativar, definir peso/principal,
remover, reiniciar e desconectar. **Código:** `src/wa/rotacao.ts`, `src/monitor/evolution.ts`,
`src/manager/server.ts`. **Teste:** `src/wa/rotacao.test.ts` cobre principal/peso/rotação; QR/rede
não têm teste. **Aceite:** QR é devolvido para a instância; estado `open` é exibido; remover/ativar
reflete na rotação.

#### RF-055 — Retomada de loops após reinício (Should · Implementado)

**Ator:** OP. **Descrição:** no boot, se `PILOTO_AUTORELIGA=1`, reagendar os loops que estavam
rodando; default 0 pausa tudo por segurança e a UI avisa. **Código:** `src/ml/piloto.ts`,
`src/manager/server.ts`. **Teste:** `src/ml/piloto.test.ts` (2).
**Aceite:** com 1, loops rodando voltam; sem a env, todos ficam pausados.

#### RF-056 — Cache de grupos da Evolution (Should · Implementado)

**Ator:** SISTEMA. **Descrição:** manter lista de grupos em cache em disco, servindo
stale-while-revalidate para o painel abrir sem esperar a Evolution; sync com pausa/backoff.
**Código:** `src/monitor/evolution.ts`. **Teste:** `src/monitor/evolution.test.ts`
("cache em disco sobrevive a falha").
**Aceite:** com Evolution fora, a última lista é devolvida e marcada com data; sync não apaga cache.

### 3.4 Operação multi-número, clientes, UI e dados

#### RF-042 — Rotação de números com peso e principal (Must · Implementado)

**Ator:** OP/SISTEMA. **Descrição:** até 5 instâncias; peso 1–10; só ativas e `open` entram no
sorteio; todos os abertos (principal inclusive) enviam, na proporção do peso; anti-repetição
probabilística (`RODIZIO_EVITA_REPETICAO=0.7`); principal preferido para operações de serviço; se um
número falha, o dispatch repete em outro; se nenhum está `open`, ainda sorteia um ativo.
**Código:** `src/wa/rotacao.ts`, `src/wa/dispatch.ts`.
**Teste:** `src/wa/rotacao.test.ts` (11). **Aceite:** com 3 números e anti-repetição 1, nunca repete
o anterior e os três aparecem; envio usa o principal também; operação de serviço sempre no principal.
**Dependências:** RF-009.

#### RF-045 — Clientes: sincronizar contatos e listas (Must · Implementado)

**Ator:** OP. **Descrição:** sincronizar participantes de todos os grupos da instância via
`GET /group/participants/{instance}?groupJid=`, deduplicar por telefone/JID, permitir cadastro
manual, renomear, remover, criar/remover listas. **Código:** `src/clientes/clientes.ts`,
`src/monitor/evolution.ts`, `src/manager/server.ts`.
**Teste:** `src/clientes/clientes.test.ts` (4). **Aceite:** importa participantes de todos os
grupos; 403 não conta como erro; 500/rate limit faz retry e o sync continua; contatos persistem em
`data/clientes.json`. **Dependências:** Evolution pareada.

#### RF-046 — Campanha e fila de clientes (Must · Implementado)

**Ator:** OP. **Descrição:** enfileirar campanha (texto, imagem, JIDs) e liberar um envio a cada
`CLIENTES_INTERVALO_S` (default 60 s), com contadores de enviados/erros e persistência em
`data/clientes-fila.json`. **Código:** `src/clientes/clientes.ts`, `src/wa/dispatch.ts`.
**Teste:** não há teste de campanha (só sync). **Aceite:** `enfileirarCampanha` devolve quantidade;
`liberarProximoCliente` envia um item e atualiza contadores; limpar a fila devolve removidos.
**Dependências:** RF-042, RF-049.

#### RF-047 — Adicionar contatos ao grupo em gotejamento (Must · Implementado)

**Ator:** OP. **Descrição:** job em background que adiciona um contato por vez, com pausa
`GRUPO_ADICIONAR_PAUSA_MS=3000`, espera `GRUPO_ADICIONAR_ESPERA_MS=45000` em rate limit e
`GRUPO_ADICIONAR_TENTATIVAS=3`; envio tem prioridade (`aguardarEnvioLivre`).
**Código:** `src/monitor/grupo-add.ts`, `src/monitor/evolution.ts`, `src/monitor/envio-lock.ts`.
**Teste:** `src/monitor/evolution.test.ts` cobre adição/retry/limite; o job em background não tem
teste. **Aceite:** job não duplica; 409 = já no grupo; progresso consultável em
`/api/clientes/grupo/status`; envio não compete com adição.

#### RF-048 — Painel com views dinâmicas e títulos editáveis (Should · Implementado)

**Ator:** OP. **Descrição:** sidebar com views (Piloto, Monitor, Números, Clientes, Contas,
Cupons, Rastreio); títulos dos cards editáveis e persistidos em `data/ui.json`.
**Código:** `src/manager/server.ts`, `src/ui/titulos.ts`. **Teste:** `src/manager/pagina.test.ts`
(3) valida HTML/JS e elementos da aba Clientes; títulos não têm teste.
**Aceite:** sidebar alterna views sem recarregar; `definirTitulo` aceita somente chaves conhecidas
e grava até 60 caracteres. **Dependências:** RF-040.

#### RF-049 — Temas (Should · Implementado)

**Ator:** OP. **Descrição:** 6 paletas (`verde`, `laranja`, `areia`, `grafite`, `marrom`, `cacau`)
aplicadas por `data-paleta` no `<html>`, persistidas em `localStorage`; card recebe fundo tingido.
**Código:** `src/manager/server.ts` (CSS + JS inline). **Teste:** `src/manager/pagina.test.ts`
valida sintaxe do painel, não as paletas. **Aceite:** trocar tema altera as variáveis e sobrevive a
reload; valor inválido no `localStorage` cai em `verde`. **Dependências:** RF-048.

#### RF-050 — Cupons do Mercado Livre (Should · Implementado)

**Ator:** OP/SISTEMA. **Descrição:** colher cupons ML, registrar código por categoria/conta e
anexar ao template quando o item não tem cupom próprio; ordem: cupom do item > código registrado >
cupom ML da categoria. **Código:** `src/ml/cupons.ts`, `src/ml/piloto.ts`.
**Teste:** não há teste de cupons. **Aceite:** cupom aparece em caixa alta no bloco
`Cupom:`; sem cupom o bloco é omitido; nome do cupom pode acompanhar o código.
**Dependências:** RF-004.

#### RF-051 — Contas ML, tag e mapa categoria → grupo (Should · Implementado)

**Ator:** OP/ADM. **Descrição:** cadastrar contas ML com tag/cookie (mascarados na API), definir
conta padrão e mapa categoria → conta/grupo/subcategoria. **Código:** `src/ml/contas.ts`,
`src/manager/server.ts`. **Teste:** não há teste dedicado. **Aceite:** API lista apenas máscaras de
tag; `resolver` usa mapa > conta explícita > padrão; cookie nunca volta pela API.
**Dependências:** RF-002.

#### RF-052 — Rastreio de publicações (Should · Implementado)

**Ator:** OP. **Descrição:** registrar toda publicação (Piloto e Monitor) com programa, categoria,
grupo, id, título, preço, link exato, tag e via; listar com filtros e exportar CSV.
**Código:** `src/store/publicacoes.ts`, `src/manager/server.ts` (`/api/rastreio`).
**Teste:** `src/store/publicacoes.test.ts` (4). **Aceite:** registro limita a 5000 itens; filtros
por programa/categoria/grupo/dias/via; CSV com cabeçalho e uma linha por publicação.
**Dependências:** RF-010, RF-034.

---

## 4. Requisitos não-funcionais

| ID | Requisito | Métrica / verificação | Status |
|---|---|---|---|
| NFR-001 | Build e tipos limpos | `npm run typecheck` e `npm run build` com exit 0 | Implementado |
| NFR-002 | Testes automatizados | `npm test` com 118 testes em 21 arquivos (node:test) | Implementado |
| NFR-003 | Persistência durável e atômica | JSON gravado em `tmp` + `rename`; estado sobrevive a restart | Implementado |
| NFR-004 | Segurança de acesso | default-deny, scrypt, cookie HttpOnly/SameSite, rate-limit, auditoria | Implementado |
| NFR-005 | Resiliência de envio | retry 3x para erro transitório; fila persistida; rotação em cada tentativa | Implementado |
| NFR-006 | Isolamento de segredos | `.env`, `data/` e `logs/` fora do Git; API não devolve cookie/hash | Implementado |
| NFR-007 | Custo de IA | stub local, `custoBRL: 0`, sem chamada de rede | Implementado |
| NFR-008 | Privacidade | auditoria sem PII, telefone mascarado, sem print de conversa | Implementado parcial |
| NFR-009 | TLS para acesso remoto | HTTPS/HSTS antes de LAN/WAN | Planejado (não implementado) |
| NFR-010 | Container non-root | `id -u != 0` e `data/` com ownership do host | Planejado (não implementado) |
| NFR-011 | Observabilidade mínima | health check e métricas de fila/erro | Parcial (sem `/health`/métricas) |
| NFR-012 | Backup/restore do JSON | restore documentado e testado | Planejado |
| NFR-013 | Rotação/retenção de logs | auditoria com retenção; logs do Piloto por dia | Parcial (auditoria sem rotação) |
| NFR-014 | Poda do dedup | remover hashes além de `DEDUP_DIAS` no carregamento | Não implementado |
| NFR-015 | Compatibilidade de runtime | Node ≥ 20, ESM, Docker Node 22-slim | Implementado |

---

## 5. Regras de negócio

### 5.1 Regras vigentes

- **RN-001 — Template RN-001 v3.** A mensagem é montada por `src/wa/formatter.ts`:
  marca opcional; `🔥 {nome}`; `ℹ️ {infoPix}` opcional; `~De {precoDe}~` opcional;
  `*Por {precoPix} no Pix*`; `*Ou {precoParc} em até {n}x*`; `🚚 {frete}` opcional;
  `🎟️ Cupom: *{CUPOM}*` opcional; `🛒 Link do Produto ⤵️`; link. O template v2 (sem De/Por e sem
  bloco de link) está histórico em `docs/11-padrao-emipe.md`.
- **RN-002 — Preço e parcelas.** O formatter usa o `precoDe` recebido; `precoParc` é o informado ou
  `precoPix * 1.11` arredondado; `parcelas` default 6. O formatter **não valida** a ordem
  Pix < parcelado < De; a fonte é responsável pelos números.
- **RN-003 — Cupom.** Sempre em caixa alta no texto (`cupom.toUpperCase()`); bloco omitido se vazio.
- **RN-004 — Link.** Só é publicado link transformado (`ok:true`); falha vai para revisão.
- **RN-005 — IA não muta dados.** O stub de IA só gera headline/subtítulo; preços, link e cupom vêm
  do item e não são alterados por IA.
- **RN-006 — Approval gate.** Existe apenas no CLI legado (`MODO`/`AUTO_APROVADO`/`fila:approve`);
  **não** é aplicado ao Piloto nem ao Monitor.
- **RN-007 — Janela e limite.** Envio dentro de `JANELA_INICIO` (default 8) e `JANELA_FIM` (default
  23), no fuso `America/Sao_Paulo`; **não há limite diário**.
- **RN-008 — Allowlist do monitor.** `mercadolivre.com.br`, `meli.la`, `mercadolibre.com`,
  `shopee.com.br`, `shope.ee`, `s.shopee.com.br`, `kabum.com.br`, `kabum.com`, `amazon.com.br`,
  `amzn.to`, `amzn.com.br`; fora disso é `desconhecido`.
- **RN-009 — Link principal.** Com vários links, vale o primeiro link de programa reconhecido; os
  demais ficam no texto.
- **RN-010 — Anti-loop.** Nenhum destino pode ser igual à origem; `adicionarRegra` rejeita.
- **RN-011 — Fan-out.** A oferta é enviada para todos os destinos ativos daquela origem (até 10),
  não apenas um.
- **RN-012 — Revisão.** Link não transformado, sem destino ou `autoEnviar=false` gera `REVISAO`,
  nunca envio com link inválido.
- **RN-013 — Limite compartilhado.** Regra histórica removida junto com o limite diário; não existe
  contador diário compartilhado no código atual.
- **RN-014 — Dedup do monitor.** Hash de `programa + idProduto` (ou `programa + link` sem id), por
  `DEDUP_DIAS` (default 7); `DEDUP_POR_ORIGEM=1` inclui a origem na chave.
- **RN-015 — Rajada.** A 4ª mensagem da mesma origem no último minuto entra na fila; liberação de
  um item a cada `MONITOR_FILA_INTERVALO_S` (default 120 s).
- **RN-016 — Rotação.** Até 5 instâncias; peso 1–10; somente ativas e `open`; anti-repetição
  probabilística de 70% (`RODIZIO_EVITA_REPETICAO`); todos os abertos enviam, inclusive o principal,
  na proporção do peso; principal preferido para serviço; fallback para ativo se nenhum estiver `open`.
- **RN-017 — Sessão.** TTL absoluto 8 h (`AUTH_TTL_HORAS`), idle 30 min (`AUTH_IDLE_MIN`), máximo 5
  sessões por usuário, cookie `alcance_sid` HttpOnly/SameSite=Strict; sessões em memória.
- **RN-018 — 2FA.** Código de 10 posições, validade 10 min, 5 tentativas, hash SHA-256 com id do
  usuário; telefone mascarado; sem telefone não bloqueia login.
- **RN-019 — Sync de contatos.** Participantes por grupo, pausa `SYNC_PAUSA_MS` (default 8000),
  backoff `SYNC_BACKOFF_MS` (default 90000), 403 não é erro.
- **RN-020 — Campanha.** Um envio a cada `CLIENTES_INTERVALO_S` (default 60 s).
- **RN-021 — Adição ao grupo.** Um contato por vez, pausa 3 s, espera 45 s em limite, 3 tentativas;
  envio tem prioridade (`ENVIO_ATIVO_MS`, default 20 s).
- **RN-022 — Temas.** 6 paletas; persistência em `localStorage`; valor inválido cai em `verde`.
- **RN-023 — Shopee.** Só o `shortLink` devolvido pela Open API conta como afiliado; `smtt` legado
  mantém `ok:false` e vai para revisão.
- **RN-024 — Amazon.** Sem `AMAZON_TAG` o Piloto não publica; o transformer aplica a tag quando
  configurada e mantém o link original se não houver transformação válida.
- **RN-025 — Chave de dedup.** Com id de produto, o link é descartado da chave (o `createLink` gera
  link novo a cada chamada); sem id, usa o link transformado.
- **RN-026 — Retenção de mídia.** Fotos em `data/midia/` são removidas após 3 dias pelo worker.
- **RN-027 — Rastreio.** Toda publicação guarda o link exato publicado, limitado a 5000 registros.

### 5.2 Colisões de RN corrigidas

| Numeração antiga | Conflito | Numeração canônica v0.4 |
|---|---|---|
| RN-008 (v0.3 allowlist) × RN-008 (delta v0.2 corte de score) | Dois significados para o mesmo ID | **RN-008 = allowlist**; corte de score não é regra vigente (o scorer usa pesos e `descontoMin`). |
| RN-010 (v0.3 dedup do monitor) × RN-010 (delta reenvio se preço cair 5%) | Dois significados | **RN-014 = dedup**; reenvio por queda de 5% não está implementado. |
| RN-011 (v0.3 1 destino) × RN-011 (delta template inalterado) | Dois significados | **RN-011 = fan-out para todos os destinos**; template consolidado em RN-001. |
| RN-013 (v0.3 contador diário compartilhado) | Regra de limite diário removida | **RN-013 = removida**; não há limite diário. |
| Comentário `RF-036` em `src/monitor/fila.ts` | Colide com RF-036 (2FA) | Corrigido: comentário agora aponta **RF-043 = fila anti-rajada**; RF-036 = verificação de celular. |
| Comentário `RF-037` em `src/monitor/midia.ts` | Colide com RF-037 (favoritos) | Corrigido: mídia agora aponta **RF-034**; **RF-037 = favoritos do ML**. |

> Os comentários foram alinhados ao SRS v0.4, que é a referência canônica de numeração.

---

## 6. Interfaces e integrações

| Integração | Contrato real | Falha / fallback | Código |
|---|---|---|---|
| Evolution API v2 — envio | `POST /message/sendText/{instance}` e `/message/sendMedia/{instance}` com `number`, `text`/`caption`, `media` e `apikey` | retry 3x em erro transitório; rotação; fila | `src/wa/dispatch.ts` |
| Evolution API v2 — grupos | `GET /group/fetchAllGroups`, `GET /group/participants`, `POST /group/updateParticipant`, `POST /group/updateSetting` | 403 = sem permissão; 500/rate limit = retry/backoff | `src/monitor/evolution.ts` |
| Evolution API v2 — estado/QR | `GET /instance/connectionState`, QR/reiniciar/desconectar | estado `open`/`close`; UI exibe | `src/wa/rotacao.ts` |
| Evolution API v2 — webhook | `messages.upsert` → `POST /api/webhook/evolution` com `X-Webhook-Key` | 401/400 descarta; origem não monitorada ignora | `src/monitor/webhook.ts`, `src/manager/server.ts` |
| Evolution GO | `EVO_GO_SEND_PATH` (default `/message/sendText/{instance}`) | mesmo dispatch | `src/wa/evolution-go.ts` |
| Mercado Livre — conversão | endpoint interno do afiliado via `converterLink` com tag/cookie | `ok:false` + revisão; sem Cloud/Afilimax | `src/ml/provider.ts` |
| Mercado Livre — página do item | `enrichItem`/`completarCandidato`/`resolverProdutoML` | sem dados → mantém texto original | `src/ml/item-page.ts`, `src/monitor/produto.ts` |
| Mercado Livre — favoritos | `POST /users/me/bookmarks` com Bearer token | sem token inerte; erro não derruba publicação | `src/ml/favoritos.ts` |
| Amazon Creators API | OAuth `client_credentials` + `POST /catalog/v1/getItems` | sem credencial → CDN/ASIN ou sem foto | `src/monitor/amazon-api.ts` |
| Shopee Open API | `POST https://open-api.affiliate.shopee.com.br/graphql`, mutation `generateShortLink`, assinatura SHA-256 | sem credencial/falha → link original + revisão | `src/monitor/shopee-api.ts` |
| IA (stub) | `gerarHeadline` determinístico + `data/trace.json` | custo 0; sem rede | `src/ai/gateway.ts` |
| Persistência | JSON atômico em `data/` | cache em memória; escrita tolerante a falha | `src/store/`, `src/monitor/state.ts`, etc. |

---

## 7. Matriz de rastreabilidade

> `Teste` indica o arquivo de teste automatizado que mais se aproxima do requisito; “—” significa
> ausência de teste dedicado (não necessariamente ausência de validação manual no `dev-log.md`).

| RF | Status | Código principal | Teste |
|---|---|---|---|
| RF-001 | Removido | `src/cli.ts`, `src/ml/piloto.ts` | — |
| RF-002 | Implementado parcial | `src/ml/provider.ts`, `src/ml/item-page.ts`, `src/monitor/produto.ts` | `monitor/transformer.test.ts` (parcial) |
| RF-003 | Implementado | `src/ml/piloto.ts`, `src/cli.ts`, `src/manager/server.ts` | — |
| RF-004 | Implementado | `src/wa/formatter.ts` | — |
| RF-005 | Adiado | `src/ai/gateway.ts` | — |
| RF-006 | Implementado | `src/wa/formatter.ts` | — |
| RF-007 | Histórico/Parcial | `src/manager/server.ts`, `docs/prototipo/index.html` | — |
| RF-008 | Parcial/legado | `src/jobs/auto.ts`, `src/cli.ts` | — |
| RF-009 | Implementado parcial | `src/wa/dispatch.ts`, `src/wa/evolution-go.ts` | `wa/rotacao.test.ts` (parcial) |
| RF-010 | Implementado | `src/ml/piloto.ts` | `ml/piloto.test.ts` (parcial) |
| RF-011 | Implementado parcial | `src/store/publicacoes.ts`, `src/manager/server.ts` | `store/publicacoes.test.ts` |
| RF-012 | Adiado | `src/wa/rotacao.ts`, `src/monitor/evolution.ts` | — |
| RF-013 | Implementado parcial | `src/ml/piloto.ts`, `src/monitor/state.ts`, `src/ai/gateway.ts` | `monitor/state.test.ts` (parcial) |
| RF-014 | Removido | — | — |
| RF-015 | Implementado | `src/ml/piloto.ts`, `src/manager/server.ts` | — |
| RF-016 | Implementado parcial | `src/hunter/service.ts`, `src/ml/hub.ts`, `src/ml/search-page.ts` | — |
| RF-017 | Implementado | `src/scorer.ts` | — |
| RF-018 | Parcial/legado | `src/jobs/auto.ts`, `src/ml/piloto.ts` | — |
| RF-019 | Implementado | `src/store/dedup.ts` | `wa/rotacao.test.ts` (dedup do monitor) |
| RF-020 | Implementado parcial | `src/ml/piloto.ts`, `src/jobs/auto.ts` | `ml/piloto.test.ts` (parcial) |
| RF-021 | Adiado | `src/scorer.ts` | — |
| RF-022 | Implementado | `src/ml/piloto.ts` | — |
| RF-023 | Implementado | `src/ml/piloto.ts` | — |
| RF-030 | Implementado | `src/monitor/grupos.ts`, `src/monitor/webhook.ts` | — |
| RF-031 | Implementado | `src/monitor/parser.ts`, `src/monitor/curtos.ts` | `monitor/parser.test.ts`, `monitor/curtos.test.ts` |
| RF-032 | Implementado parcial | `src/monitor/transformer.ts`, `src/monitor/shopee-api.ts` | `monitor/transformer.test.ts`, `monitor/shopee-api.test.ts` |
| RF-033 | Implementado | `src/monitor/webhook.ts`, `src/wa/formatter.ts` | — |
| RF-034 | Implementado | `src/monitor/webhook.ts`, `src/wa/dispatch.ts` | `monitor/evolution.test.ts` (parcial) |
| RF-035 | Implementado | `src/monitor/state.ts`, `src/monitor/webhook.ts` | `monitor/state.test.ts`, `wa/rotacao.test.ts` |
| RF-036 | Implementado | `src/manager/verificacao.ts`, `scripts/auth-user.mjs` | `manager/verificacao.test.ts` |
| RF-037 | Implementado | `src/ml/favoritos.ts`, `src/ml/piloto.ts` | `ml/favoritos.test.ts` |
| RF-040 | Implementado | `src/manager/auth.ts`, `src/manager/server.ts` | `manager/auth.test.ts` |
| RF-041 | Implementado | `src/manager/auth.ts`, `src/manager/server.ts` | `manager/auth.test.ts` |
| RF-042 | Implementado | `src/wa/rotacao.ts`, `src/wa/dispatch.ts` | `wa/rotacao.test.ts` |
| RF-043 | Implementado | `src/monitor/fila.ts` | `monitor/fila.test.ts` |
| RF-044 | Não implementado | `src/monitor/webhook.ts` (só leitura) | — |
| RF-045 | Implementado | `src/clientes/clientes.ts` | `clientes/clientes.test.ts` |
| RF-046 | Implementado | `src/clientes/clientes.ts` | — |
| RF-047 | Implementado | `src/monitor/grupo-add.ts`, `src/monitor/evolution.ts` | `monitor/evolution.test.ts` (parcial) |
| RF-048 | Implementado | `src/manager/server.ts`, `src/ui/titulos.ts` | `manager/pagina.test.ts` (parcial) |
| RF-049 | Implementado | `src/manager/server.ts` | `manager/pagina.test.ts` (só sintaxe) |
| RF-050 | Implementado | `src/ml/cupons.ts`, `src/ml/piloto.ts` | — |
| RF-051 | Implementado | `src/ml/contas.ts`, `src/manager/server.ts` | — |
| RF-052 | Implementado | `src/store/publicacoes.ts`, `src/manager/server.ts` | `store/publicacoes.test.ts` |
| RF-053 | Implementado | `src/monitor/evolution.ts` | `monitor/evolution.test.ts` |
| RF-054 | Implementado | `src/wa/rotacao.ts`, `src/monitor/evolution.ts` | `wa/rotacao.test.ts` (parcial) |
| RF-055 | Implementado | `src/ml/piloto.ts` | `ml/piloto.test.ts` |
| RF-056 | Implementado | `src/monitor/evolution.ts` | `monitor/evolution.test.ts` |

### 7.1 Cobertura automatizada por arquivo (118 testes)

| Arquivo | Testes |
|---|---:|
| `src/amazon/amazon.test.ts` | 5 |
| `src/clientes/clientes.test.ts` | 4 |
| `src/manager/auth.test.ts` | 8 |
| `src/manager/pagina.test.ts` | 3 |
| `src/manager/verificacao.test.ts` | 8 |
| `src/ml/favoritos.test.ts` | 5 |
| `src/ml/piloto.test.ts` | 2 |
| `src/monitor/amazon-api.test.ts` | 6 |
| `src/monitor/curtos.test.ts` | 9 |
| `src/monitor/grupos-sync.test.ts` | 2 |
| `src/monitor/grupos-vistos.test.ts` | 1 |
| `src/monitor/evolution.test.ts` | 13 |
| `src/monitor/fila.test.ts` | 4 |
| `src/monitor/parser.test.ts` | 6 |
| `src/monitor/shopee-api.test.ts` | 10 |
| `src/monitor/state.test.ts` | 5 |
| `src/monitor/transformer.test.ts` | 5 |
| `src/store/publicacoes.test.ts` | 5 |
| `src/wa/dispatch.test.ts` | 5 |
| `src/monitor/webhook.test.ts` | 1 |
| `src/wa/rotacao.test.ts` | 11 |
| **Total** | **118** |

---

## 8. Riscos e mitigações

| Risco | Prob. | Impacto | Mitigação atual / pendente |
|---|---|---|---|
| Banimento de número pela Evolution/Baileys | Média | Alto | Rotação, jitter, janela, fila anti-rajada, envio distribuído entre todos os abertos; falta aquecimento formal e limite diário (removido). |
| Cookie/tag ML expira | Alta | Médio | Conversão falha vai para revisão; não há health-check automático (RF-012 adiado). |
| Credenciais Shopee/Amazon ausentes ou não aprovadas | Alta | Médio | Módulos inertes; link original + revisão; fallback CDN/ASIN na Amazon. |
| Link sem comissão (`smtt`) | Média | Alto | RN-023 bloqueia `smtt` como transformação válida. |
| Duplicação de ofertas | Média | Médio | Dedup 7d configurável; falta poda por idade (NFR-014). |
| Perda de estado JSON | Baixa | Alto | Escrita atômica e cache em memória; falta backup automatizado (NFR-012). |
| Acesso remoto sem TLS | Média | Alto | `manager-novo` em loopback; compose base exposto exige firewall/TLS (NFR-009). |
| Container/`data/` como root | Alta | Médio | Pendente (`user:`/`chown`) — NFR-010. |
| XSS/CSP com `unsafe-inline` | Média | Médio | HTML/JS inline em `server.ts`; CSP restritiva, mas `unsafe-inline` permanece. |
| Rajada de webhook/abuso | Média | Médio | `X-Webhook-Key` e fila; rate-limit dedicado no webhook não existe. |
| Sessões em memória | Baixa | Baixo | Restart desloga; aceitável no single-node atual. |
| IA alucinar preço | Baixa | Alto | Stub não gera preço; IA paga não está ligada. |

---

## 9. Glossário

- **Alcance** — nome do produto/painel; pacote legado `automensagemwhats`.
- **Evolution API** — gateway não oficial de WhatsApp (Baileys) usado para envio, grupos e webhook.
- **JID** — identificador de contato/grupo do WhatsApp.
- **Origem/destino** — grupo monitorado / grupo próprio que recebe o repasse.
- **Rajada** — 4ª mensagem da mesma origem em 1 minuto; entra na fila.
- **Dedup** — bloqueio de repetição por hash de produto/link.
- **Rotação** — sorteio ponderado do número remetente.
- **Principal/secundário** — principal é o número preferido para serviço; ambos (e os demais abertos) participam do envio conforme o peso.
- **2FA de ativação** — código de 10 posições no primeiro login.
- **Stub de IA** — gerador local determinístico, sem LLM e custo 0.
- **Rastreio** — registro do link exato publicado em `data/publicacoes.json`.
- **Cesta** — lista manual de ofertas por categoria (`data/cestas.json`).
- **Trace** — linha em `data/trace.json` com modelo, latência, custo e id.

---

*Fim do SRS v0.4. Requisitos marcados como adiados/removidos não devem ser tratados como
compromissos de entrega. Para decisões, consulte `docs/04-ADRs/`; para o histórico, `docs/dev-log.md`.*
