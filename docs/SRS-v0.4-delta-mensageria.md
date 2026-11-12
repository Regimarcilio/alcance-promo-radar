# SRS — Alcance — delta de Mensageria (v0.4 + Mensageria)

> **Data:** 2026-11-11 · **Base:** [`docs/SRS-v0.4.md`](SRS-v0.4.md) · **Épico:** #47 ·
> **ADR:** [`docs/04-ADRs/ADR-011-mensageria.md`](04-ADRs/ADR-011-mensageria.md) ·
> **Issues:** #48 (núcleo), #49 (ACK/DLQ), #50 (idempotência), #51 (tópicos), #52 (observabilidade)
>
> Este delta **acrescenta** os requisitos da camada de Mensageria ao SRS v0.4. Não altera nenhum
> requisito vigente (RF-001–056, RN-001–027): os fluxos existentes (Monitor, Piloto, Clientes,
> Rastreio, painel) seguem com o mesmo comportamento — a diferença é que a **fila de Campanhas
> deixou de perder mensagens** (o `shift()` antes do envio foi eliminado).

---

## 1. Motivo

Em 10/11/2026 uma queda de números (`device_removed` / `Connection Closed`) **perdeu 206 mensagens**
de uma campanha de 550: a fila de Clientes retirava o item da fila (`itens.shift()`) **antes** de
enviar, e a falha só deixava `erros++`. Não havia envelope, portanto não havia `correlationId`
(nada ligava "oferta recebida" a "mensagem enviada"), nem DLQ (o que falhava morria sem registro),
nem idempotência (reprocessar podia mandar a mesma propaganda duas vezes).

A aula de **Mensageria — Comunicação entre Aplicações** (10/11/2026) define a semântica que faltava:
ACK, retry com backoff, DLQ, idempotência por chave de negócio, tópicos (Pub/Sub) e observabilidade
por correlação. Este delta registra essa semântica **como requisito do produto**.

## 2. Escopo

**IN (implementado):**

- Camada interna de Mensageria com **port/adaptador**: envelope padronizado e versionado, broker
  substituível (adapter de arquivo hoje), registro global do broker.
- **ACK real** na fila de Campanhas e na fila do Monitor, com **retry** (backoff exponencial +
  jitter) e **Dead Letter Queue** com motivo e reprocessamento explícito.
- **Idempotência por chave de negócio** nos consumidores (registro gravado junto do ACK).
- **Tópicos (Pub/Sub)** com **fila por assinante**, reentrega e semântica de tópico.
- **Observabilidade**: métricas Prometheus da mensageria e rastreio por `correlationId`.

**OUT (fora deste delta):**

- Broker externo (RabbitMQ/Kafka/Redis/SQS) — decisão do operador e do ADR-011: a arquitetura fica
  pronta, a infra não entra nesta etapa.
- UI da Mensageria (protótipo #53 e tela #54) — depende de aprovação do operador.
- Rastreamento distribuído (OpenTelemetry), exactly-once e deduplicação semântica de texto.

## 3. Requisitos funcionais

#### RF-057 — Envelope padronizado e abstração de broker (Must · Implementado)
Toda mensagem da camada de Mensageria é um envelope serializável em JSON puro com `id`, `tipo`,
`versao`, `timestamp`, `correlationId`, `chave?`, `tentativas` e `payload`, validado por schema
**zod**. Produtores e consumidores falam apenas com a **port** `Broker`
(`publish`/`consume`/`ack`/`nack`/`tamanho`/`dlq`/`reprocessar`/`stats`); o adapter de arquivo
(`FileBroker`) é a implementação atual e pode ser substituído por registro no broker global, **sem
alterar produtores nem consumidores**. Tipos de mensagem e de evento ficam num catálogo central com
schema por evento.

#### RF-058 — ACK real, retry com backoff e DLQ (Must · Implementado)
A mensagem **só sai da fila depois de ser processada com sucesso**. Enquanto é processada, fica
reservada (`emAndamento`/`reservadoEm`) sem ser removida. Falha transitória devolve o item à fila
com `tentativas + 1`, `ultimoErro` e `proximaTentativaEm`; erro **não transitório** ou
**tentativas esgotadas** vão para a **DLQ** com o motivo (nunca para o lixo). A DLQ não bloqueia o
fluxo, tem retenção limitada e **só volta por ação explícita do operador**. Reserva abandonada
(crash) é liberada de volta para a fila.

#### RF-059 — Idempotência por chave de negócio nos consumidores (Should · Implementado)
Cada tipo de mensagem tem uma **chave de negócio** (`cliente.enviar` → `${disparoId}:${jid}`;
`monitor.encaminhar` → hash `mlbId|preco|cupom`; `monitor.add-grupo` → `${jid}:${telefone}`; evento
→ `${tipo}:${id}`). Antes do efeito, o consumidor consulta o registro de processados: se a chave já
foi processada, a mensagem é **confirmada (ACK) sem reenviar** e o evento de duplicata é
contabilizado. A chave é gravada **junto do ACK** (nunca antes) — semântica at-least-once com chave.
O registro tem retenção (30 dias) e limite (50 000 chaves); o dedup de 7 dias do Monitor passa a
reusar a mesma estrutura **sem mudar a API pública**.

#### RF-060 — Tópicos de eventos (Pub/Sub) com fila por assinante (Should · Implementado)
O produtor publica um evento e **não conhece** os assinantes. Cada assinante tem **fila própria**:
um assinante que falha não afeta os outros e um assinante que estava fora do ar recebe o que ficou
na fila dele (reentrega). **Assinante novo não recebe histórico** (semântica de tópico). Todo
evento tem payload validado por schema zod — a publicação é rejeitada se o payload não bater.

#### RF-061 — Observabilidade da mensageria (Must · Implementado)
A camada expõe métricas Prometheus por tipo (`alcance_msg_publicadas_total`,
`alcance_msg_processadas_total`, `alcance_msg_fila_tamanho`, `alcance_msg_dlq_tamanho`,
`alcance_msg_retries_total`, `alcance_msg_duplicadas_total`, `alcance_msg_idade_fila_ms`,
`alcance_msg_taxa_erro`, `alcance_msg_latencia_envio_ms`) e **rastreio por `correlationId`** em log
estruturado. O `correlationId` é herdado do contexto quando não vem explícito e **atravessa** o
fluxo (webhook → oferta → fila → envio → evento). Nenhum log carrega PII.

## 4. Regras de negócio

- **RN-028 — ACK.** Nenhum item de fila é removido antes do sucesso do efeito; reserva abandonada
  (acima de 5 min) volta para a fila.
- **RN-029 — Retry.** Backoff `base * 2^(tentativas-1)` (base 30 s, teto 30 min) com jitter de
  ±20%; re-tenta **apenas** erro transitório (`Connection Closed`, `Precondition Required`, 5xx,
  timeout, `ECONNRESET`); erro permanente vai direto para a DLQ.
- **RN-030 — DLQ.** Uma entrada por mensagem morta com envelope, motivo, `tentativas`,
  `ultimaTentativaEm` e `origem`; retenção de 1000 itens por tipo; item na DLQ **não volta
  sozinho** — só por `POST /api/mensageria/dlq/reprocessar`.
- **RN-031 — Chave de idempotência.** A chave é calculada por tipo, vai no campo `chave` do
  envelope e é registrada **junto do ACK**; falha antes do ACK implica reenvio (at-least-once).
- **RN-032 — Correlação.** O `correlationId` é gerado quando não há contexto, herdado quando existe
  (`comCorrelacao`) e propagado para os eventos publicados; o log da mensagem processada carrega
  `tipo`, `chave`, `correlationId`, `ok`, `tentativas` e `duracaoMs` como campos estruturados.

## 5. Interfaces novas (API, sem UI)

| Endpoint | Uso |
| --- | --- |
| `GET /api/mensageria/filas` | retrato por tipo: pendentes, processadas, falhas, dlq, mais antiga |
| `GET /api/mensageria/dlq?tipo=` | itens da DLQ com o motivo |
| `POST /api/mensageria/dlq/reprocessar` `{ id }` | devolve o item da DLQ para a fila |
| `GET /api/mensageria/events` → `eventos` | eventos recentes + estado dos assinantes |
| `GET /api/mensageria/stats` | snapshot por tipo (inclui idade da fila e taxa de erro) |

## 6. Matriz de rastreabilidade

| RF | Implementação | Testes |
| --- | --- | --- |
| RF-057 | `src/messaging/envelope.ts`, `src/messaging/broker.ts`, `src/messaging/tipos.ts` | `messaging/envelope.test.ts`, `messaging/broker.test.ts`, `messaging/tipos.test.ts` |
| RF-058 | `src/clientes/fila.ts`, `src/clientes/clientes.ts`, `src/monitor/fila.ts`, `src/messaging/politica.ts`, `src/messaging/dlq.ts` | `clientes/clientes.test.ts`, `monitor/fila.test.ts` |
| RF-059 | `src/messaging/idempotencia.ts`, `src/clientes/fila.ts`, `src/clientes/clientes.ts`, `src/store/dedup.ts` | `messaging/idempotencia.test.ts`, `clientes/clientes.test.ts` |
| RF-060 | `src/messaging/eventos.ts`, `src/messaging/consumidores.ts` + produtores (`monitor/webhook.ts`, `clientes/clientes.ts`, `wa/rotacao.ts`, `manager/server.ts`) | `messaging/eventos.test.ts` |
| RF-061 | `src/monitor/metrics.ts`, `src/messaging/contadores.ts`, `src/messaging/filas.ts` | `monitor/metrics.test.ts`, `clientes/clientes.test.ts` |

## 7. Evidência

- `npm run typecheck` ✅ · `npm run build` ✅ · `npm test` → **273/273** ✅ · smoke do manager ✅
  (nenhum teste existente foi alterado; os 3 testes da fila de Clientes foram **adaptados** porque
  a fila migrou do store legado para o broker — comportamento asserido idêntico).
- PRs: #48 → #55 · #49 → #57 · #50 → #58 + #60 (completa) · #51 → #61 · #52 → #62.

## 8. Premissas registradas

1. **O arquivo legado `data/clientes-fila.json` não é apagado** — é esvaziado depois da migração
   bem-sucedida e continua como registro do estado antigo (o estado da fila foi para
   `data/clientes-estado.json`).
2. **A fila do Monitor não migrou para o broker** — manteve o store próprio
   (`data/monitor-fila.json`) e recebeu a **mesma semântica** (ACK, retry de 3 tentativas,
   `reenfileirar` idempotente) e a **mesma DLQ** (`dlq-monitor.encaminhar.json`).
3. **Sem broker externo nesta etapa** (decisão do operador), mas a port permite trocar o adapter.
4. **A UI da Mensageria não existe ainda** (#53/#54): os endpoints já entregam o que a tela vai
   precisar (filas, DLQ, reprocessar, eventos e stats).
