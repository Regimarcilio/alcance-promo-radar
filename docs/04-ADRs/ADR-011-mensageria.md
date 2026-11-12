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
