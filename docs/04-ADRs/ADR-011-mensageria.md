# ADR-011 — Mensageria interna: envelope padronizado, port de broker e file broker

> Data: 2026-11-11 | Status: Aceita (implementada — `src/messaging/`)

## Contexto

O Alcance é um processo único (single-node) que hoje conversa com o WhatsApp (Evolution),
com o painel e com a Evolution de forma **direta e acoplada**: quem produz chama quem
consome, no mesmo call stack. Isso traz três problemas concretos, todos observados em
produção:

1. **Perda de mensagens.** A fila de Campanhas (`src/clientes/clientes.ts`) fazia
   `itens.shift()` **antes** de enviar: se o envio falhasse, o item já tinha saído da
   fila e a propaganda **sumia** (sobrava apenas `erros++`). Em 10/11/2026, quando os
   números caíram (`device_removed` / `Connection Closed`), uma campanha de 550
   mensagens **perdeu 206** — 37% do lote, sem DLQ, sem motivo, sem reprocesso.
2. **Sem rastreio.** Não existe envelope, portanto não existe `correlationId`: não dá
   para ligar "oferta recebida no webhook" a "mensagem enviada" no mesmo fluxo.
3. **Sem idempotência generalized.** Só o Monitor tinha dedup (hash de
   `mlbId + preço + cupom`, 7 dias). Campanha re-executada ou reentrega depois de ACK
   perdido manda **a mesma propaganda duas vezes** ao cliente.

A aula de **Mensageria — Comunicação entre Aplicações** (10/11/2026) dá o vocabulary
que falta: envelope padronizado, **ACK** (a mensagem só sai da fila depois de
processada), **retry com backoff**, **Dead Letter Queue**, **idempotência por chave de
negócio**, **tópicos (Publicação/Assinatura)** e **observabilidade** (tamanho de fila,
latência, dead letters, correlação).

A questão deste ADR é **onde** implementar essa semântica — não se implementa.

## Decisão

Implementamos uma **camada de Mensageria interna** no Alcance, com **port/adaptador**:

- **Port** (`src/messaging/broker.ts`): a interface `Broker`
  (`publish`/`consume`/`ack`/`nack`/`tamanho`/`dlq`/`reprocessar`/`stats`).
  Produtores e consumidores falam **sempre** com a port — nunca com o transporte.
- **Adapter inicial: arquivo** (`FileBroker`). Filas em `data/messaging/<tipo>.json`
  (array de envelopes), DLQ em `data/messaging/dlq-<tipo>.json`, contadores em
  `data/messaging/stats-<tipo>.json`. Escrita **atômica** com `gravarJsonAtomico`
  (`src/store/json.ts`, arquivo `0600`).
- **Envelope padronizado e versionado** (`src/messaging/envelope.ts`):
  `{ id, tipo, versao, timestamp, correlationId, chave?, tentativas, payload }`,
  validado com **zod**, serializável em JSON puro. A correlação é **herdada do
  contexto** (`AsyncLocalStorage`), então webhook → oferta → fila → envio → evento
  compartilham o mesmo `correlationId`.
- **Catálogo central de tipos** (`src/messaging/tipos.ts`): tipos de mensagem e de
  evento com **schema zod** por evento — nenhum tipo "solto" no código.
- **Registro global do broker** (`setBroker`/`getBroker`): permite registrar outro
  adapter (AMQP, SQS, Kafka) **sem tocar em produtores nem consumidores**.

O ganho imediato é a **semântica** (ACK, DLQ, idempotência, correlação), não o
transporte: é isso que impede a próxima perda de 206 mensagens.

### Alternativas avaliadas

| Alternativa | Por que não agora | Condição para revisar |
| --- | --- | --- |
| **RabbitMQ (AMQP)** | Dependência de infra nova (container, credenciais, volume, monitoring) para um processo single-node; complexidade operacional (troca de senha, policy, dead-letter nativo) sem ganho proporcional — a semântica é o que importa | quando entrar um **segundo processo consumidor** ou quando o volume exigir throughput de broker |
| **Kafka** | Overhead alto para o padrão de carga do Alcance (milhares de mensagens/dia, não milhões); Kafka é event log, não fila com ACK por consumidor | volume de eventos em regime de streaming (milhares/s) |
| **Redis Streams** | Mais próximo do modelo desejado (consumer groups, reentrega), mas ainda é infra nova + persistência/aof para não perder mensagem | segunda JVM/processo precisar consumir a mesma fila |
| **SQS/SNS** | Serviço gerenciado da AWS: bom para fan-out de evento, mas exige conta/custo/região e latency de rede no caminho crítico do envio | operação multi-região ou multi-tenant |
| **SQLite** | Dura e transacional, mas **não é broker**: não dá ACK/retry/DLQ nativo nem isolamento de assinante; a semântica seria reimplementada "na mão" (o que é exatamente o que a camada de Mensageria faz — em arquivo) | quando a fila precisar de transações com o resto do estado |
| **Arquivo (escolhido)** | Sem infra nova, com a mesma semântica de broker; limitação: não escala para múltiplos processos e a "visibilidade" da fila é por arquivo | mesma condição das demais (segundo consumidor / throughput) |

### Consequências

- **+** Nenhuma mensagem se perde em falha de envio: só sai da fila no **ACK**.
- **+** Falha vira **retry com backoff** ou **DLQ com motivo** — nunca lixo silencioso.
- **+** Fluxo rastreável ponta a ponta (`correlationId`).
- **+** Produtor e consumidor desacoplados: trocar o transporte é registrar outro adapter.
- **+** Tópicos (Pub/Sub) com fila por assinante: um assinante que falha não afeta os outros.
- **−** Arquivo não é transacional nem multi-processo: o ACK é "tirar da fila" no arquivo.
- **−** A migração do legado (`data/clientes-fila.json` → fila `cliente.enviar`) é
  **aditiva**: o arquivo legado **não** é apagado pela migração, porque até a fila de
  Clientes consumir do broker (issue #49) o store legado ainda é a fonte lida pelo
  worker. A migração é **idempotente** (id do envelope = id do item legado).
- **−** Escrita em arquivo não é atômica entre tipos: cada fila é consistente por si.

## Referências

- Implementação: `src/messaging/envelope.ts`, `src/messaging/broker.ts`, `src/messaging/tipos.ts`
- Testes: `src/messaging/envelope.test.ts`, `src/messaging/broker.test.ts`, `src/messaging/tipos.test.ts`
- ADR relacionados: [ADR-001](ADR-001-envio-whatsapp.md) (envio), [ADR-007](ADR-007-clientes-campanhas.md) (campanhas/fila)
- Épico: #47 (Camada de Mensageria interna) — issues #48 (núcleo), #49 (ACK/DLQ), #50 (idempotência), #51 (tópicos), #52 (observabilidade)
- SRS: RF/RN de Mensageria registrados no delta `docs/SRS-v0.4.md`

---

## Addendum (2026-11-11) — issue #49: ACK, retry e DLQ na prática

A decisão acima foi aplicado no fluxo de Campanhas (aba Clientes) e na fila do Monitor:

- **Fila de Campanhas = fila de Mensageria.** Os itens migraram de
  `data/clientes-fila.json` (store legado, itens "soltos") para
  `data/messaging/cliente.enviar.json` (um **envelope** por contato). O estado
  da fila (contadores, pausa, último envio) passou para `data/clientes-estado.json`
  — o legado é **herdado** na primeira leitura (histórico de 254 enviados /
  206 erros preservado) e a migração é **idempotente** (marcador de ids
  migrados + esvazia o legado só depois da gravação bem-sucedida; o arquivo
  legado **não é apagado**).
- **ACK real.** O item **fica na fila** enquanto é enviado (reserva com
  `emAndamento`/`reservadoEm`); só sai no ACK (sucesso). NACK devolve o item
  com `tentativas + 1`, `ultimoErro` e `proximaTentativaEm`; erro permanente
  ou tentativas esgotadas vão para a **DLQ** (`data/messaging/dlq-<tipo>.json`,
  retenção de 1000 itens) com o motivo — nunca para o lixo.
- **Política de retry** (`src/messaging/politica.ts`): backoff `base * 2^(n-1)`
  (base 30s, teto 30 min) com **jitter de ±20%**; só erro **transitório**
  (`ehErroTransitorio`) é re-tentado; erro permanente vai direto para a DLQ.
- **Extensões do port** (opcionais, para não quebrar adapters mínimos):
  `pendentes(tipo)`, `atualizar(id, env)`, `remover(id)`, `limpar(tipo)` — o
  consumidor precisa delas para reservar/editar/cancelar itens. A fila do
  Monitor **não** usa o broker (store próprio `data/monitor-fila.json`) para
  não reescrever o comportamento já testado, mas passa a usar a **mesma
  semântica** (ACK, retry de 3 tentativas, `reenfileirar` idempotente) e a
  **mesma DLQ** (`dlq-monitor.encaminhar.json`).
- **Recuperação de crash**: reserva com mais de 5 min é liberada de volta para
  a fila (Clientes) e o item em andamento volta no boot (Monitor).

---

## Addendum (2026-11-11) — issue #50: idempotência por chave de negócio

- **Chave por tipo de mensagem** (`src/messaging/idempotencia.ts` → `chaveDe`):
  `cliente.enviar` → `${disparoId}:${jid}`; `monitor.encaminhar` → hash
  `mlbId|preco|cupom` (o mesmo do Monitor); `monitor.add-grupo` → `${jid}:${telefone}`;
  evento de tópico → `${tipo}:${id}`.
- **Consumidor idempotente**: antes do efeito o consumidor consulta o registro; se a
  chave já foi processada → **ACK imediato, sem reenviar** (log
  `[mensageria] duplicata ignorada: <chave>`) e o contador
  `alcance_msg_duplicadas_total{tipo}` sobe. A chave é gravada **junto do ACK**
  (nunca antes) → at-least-once com chave (recomendação da aula).
- **Registro genérico**: retenção de 30 dias e limite de 50 000 chaves
  (`data/messaging/processados.json`), com escrita atômica. O dedup do Monitor
  (`src/store/dedup.ts`) passou a **reusar a mesma estrutura** — retenção de 7 dias,
  formato de arquivo (`{hash, data, dia}`) e API pública (`hashEnvio`, `jaEnviado`,
  `registrarEnvio`) **inalterados** (histórico preservado).
- **Métrica**: `alcance_msg_duplicadas_total{tipo}` (contador em memória, exportado
  no Prometheus pela issue #52).

---

## Addendum (2026-11-11) — issue #51: tópicos (Publicação/Assinatura)

- **Tópicos** (`src/messaging/eventos.ts`): `publicarEvento` / `assinarEvento` /
  `desassinarEvento`. O produtor publica e **não conhece** os assinantes.
- **Fila por assinante**: `data/messaging/topico-<tipo>-<assinante>.json` — um
  assinante que falha **não afeta** os outros e um assinante que estava fora do
  ar recebe o que ficou na fila dele (reentrega no boot, via `processarPendentes`).
- **Semântica de tópico**: assinante **novo não recebe histórico** — a fila do
  assinante só passa a existir a partir da primeira publicação feita enquanto ele
  estava assinado.
- **Payload validado** pelo schema zod do tipo (`src/messaging/tipos.ts`): a
  publicação é **rejeitada** se o payload não bater com o schema.
- **Consumidores padrão** (`src/messaging/consumidores.ts`): `auditoria`
  (append-only em `data/auditoria-mensageria.json`, sem PII), `metricas`
  (contadores) e `log` (linha estruturada com `correlationId`).
- **Produtores**: `oferta.recebida` (webhook da Evolution), `disparo.criado`
  (painel), `disparo.mensagem.enviada` e `disparo.concluido` (worker de
  clientes), `instancia.conectada`/`instancia.desconectada` (camada de
  rotação, na mudança de estado) e `mensagem.dlq` (quando algo morre na DLQ).
- **Correlação**: o `correlationId` do envelope é propagado para o evento
  publicado; o painel cria a campanha dentro de `comCorrelacao(...)` e os
  itens da fila herdam o mesmo identificador → `disparo.criado`,
  `disparo.mensagem.enviada` e `disparo.concluido` compartilham a correlação.

---

## Addendum (2026-11-11) — issue #52: observabilidade da mensageria

- **Métricas Prometheus** (`src/monitor/metrics.ts`): `alcance_msg_publicadas_total{tipo}`,
  `alcance_msg_processadas_total{tipo,resultado}` (`ok`|`erro`|`dlq`),
  `alcance_msg_fila_tamanho{tipo}`, `alcance_msg_dlq_tamanho{tipo}`,
  `alcance_msg_retries_total{tipo}`, `alcance_msg_duplicadas_total{tipo}`,
  `alcance_msg_idade_fila_ms{tipo}`, `alcance_msg_taxa_erro{tipo}` e o histograma
  `alcance_msg_latencia_envio_ms{tipo}`. A métrica antiga `alcance_fila_tamanho` continua
  exposta (compatibilidade).
- **Rastreio por `correlationId`**: o log da mensagem processada carrega campos
  **estruturados** (pino): `tipo`, `chave`, `correlationId`, `ok`, `tentativas`, `duracaoMs` —
  sem concatenar texto solto. O `correlationId` atravessa o fluxo
  (webhook → oferta → fila → envio → evento).
- **Diagnóstico**: `GET /api/mensageria/stats` devolve o snapshot por tipo (pendentes,
  processadas, falhas, DLQ, mais antiga, idade e taxa de erro).
- **Grafana**: o dashboard provisionado ganhou os painéis de fila/DLQ/duplicatas.

---

## Addendum (2026-11-12) — issue #78: duplicata deixa de ser descartada e vira **reenvio** (+24h)

### Contexto

A idempotência do #50 **descartava** a duplicata: em `src/clientes/clientes.ts` a
mensagem era confirmada (ACK) sem reenviar, com o log `duplicata ignorada`. O
operador pediu o contrário: a duplicata deve **voltar para a fila** e ser
reenviada **24h depois do lançamento original**, **pela sequência da fila**
(mesmo ritmo anti-rajada, mesma janela comercial, mesmo ACK/retry/DLQ) — nunca
por um envio avulso.

### Decisão

- **Núcleo genérico** (`src/messaging/reenvio.ts`): `agendarReenvioDuplicado(env)`
  devolve o envelope **reagendado** (`proximaTentativaEm` = lançamento + N horas,
  marcador `reenvio: {originalEm, agendadoEm, chave}`), preservando
  `correlationId` e a chave; `ehReenvioAgendado(env)` faz o consumidor **pular a
  checagem de idempotência** no reenvio (senão ele se reagendaria em loop);
  `reenvioPermitido(tipo)` decide pelo switch global e pelo switch por tipo.
- **O relógio é o lançamento original** (`envelope.timestamp` / item `criadoEm`),
  não a detecção da duplicata — decisão do operador (12/11/2026).
- **Regra do "próximo momento válido"**: `alvo = lançamento + N horas` e, enquanto
  `alvo <= agora`, `alvo = alvo + N horas`. Com o padrão de 24h, uma mensagem
  lançada ontem às 08:00 e detectada hoje às 10:00 é reagendada para **as 08:00
  de amanhã**. `proximaTentativaEm` **nunca** fica no passado; a fila continua
  respeitando a janela comercial e o intervalo anti-rajada (o reagendamento só
  define *quando* a mensagem fica elegível).
- **Reenvio único**: se o reenvio falhar, cai no **retry/DLQ normal** (backoff
  exponencial, até 3 tentativas) — o marcador `reenvio` viaja com o envelope e
  **não** gera um novo +24h.
- **Switches** (desligáveis sem mexer em código):
  `MENSAGERIA_REENVIO_DUP_ATIVO` (1 = ligado), `MENSAGERIA_REENVIO_DUP_HORAS`
  (24) e `MENSAGERIA_REENVIO_DUP_TIPOS` (`cliente.enviar,monitor.encaminhar`,
  `*` = todos). Com o switch desligado, a duplicata volta ao **descarte**
  (comportamento do #50).

### ⚠️ Efeito colateral no Monitor (risco aceito pelo operador em 12/11/2026)

No Monitor a chave de negócio é o **hash da oferta** (`mlbId|preco|cupom` — a
mesma do Piloto), não o id do item. Consequência: **a mesma oferta encaminhada
antes é reencaminhada aos grupos 24h depois** (não é "a mesma oferta para o
mesmo contato", é "a mesma oferta para os grupos"). Isso vale também para a
mesma oferta publicada por **origens diferentes** quando `DEDUP_POR_ORIGEM=1`.

Mitigações: `MENSAGERIA_REENVIO_DUP_TIPOS=cliente.enviar` desliga o reenvio só
do Monitor; `MENSAGERIA_REENVIO_DUP_ATIVO=0` desliga em todos os fluxos. O
painel mostra a origem do reenvio (badge **↻ reenvio 24h**) na tabela de DLQ e
na de eventos.

### Observabilidade

- `alcance_msg_duplicatas_reagendadas_total{tipo}` — duplicatas reagendadas.
- `alcance_msg_reenvios_realizados_total{tipo}` — reenvios efetivamente enviados.
- `alcance_msg_reenvios_agendados_horas{tipo}` — gauge do tempo de espera (aging).
- Eventos `disparo.mensagem.reagendada` (Clientes) e `mensagem.reagendada`
  (Monitor), com `chave`, `originalEm`, `agendadoEm`, `envioEm` e `correlationId`.

### Alternativas avaliadas

| Alternativa | Por que não |
| --- | --- |
| Envio avulso 24h depois (sem fila) | quebra o ritmo anti-rajada e a janela comercial; não passa por ACK/retry/DLQ |
| Reagendar a partir da **detecção** | o operador definiu que as 24h contam do **lançamento** |
| Reenviar em loop (a cada 24h) | spam; o reenvio é **único** |
| Reenviar o Monitor pela chave do item | a chave do Monitor é o **hash da oferta**; a chave do item não detecta a oferta repetida |

### Referências

- Implementação: `src/messaging/reenvio.ts`, `src/clientes/clientes.ts`,
  `src/clientes/fila.ts`, `src/monitor/fila.ts`, `src/monitor/webhook.ts`
- Testes: `src/messaging/reenvio.test.ts`, `src/clientes/clientes.test.ts`,
  `src/monitor/fila.test.ts`
- Épico: #47 (Camada de Mensageria interna) — issue #78
