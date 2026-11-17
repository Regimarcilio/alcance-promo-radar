# ADR-012 — Banco SQLite para o catálogo de ofertas (branch `expansion`)

> Data: 2026-11-16 | Status: Aceita (implementação em andamento — branch `expansion`)

## Contexto

O Alcance persiste todo o estado em JSON atômico (`src/store/`). Dois stores concentram
o histórico de ofertas:

| Store | Arquivo | Tamanho hoje | Registros | Escrita |
|---|---|---|---|---|
| Rastreio (o que **nós** publicamos) | `data/publicacoes.json` | 2,26 MB | 6.874 | reescreve o arquivo **inteiro** |
| Catálogo de ofertas recebidas | **não existe** | — | — | — |

Medições (2026-11-16, container de produção, Node 22.23.4):

- `listarPublicacoes()`: 225 ms (leitura + `JSON.parse` de 2,26 MB) por consulta;
- gravar 1 publicação: **177 ms** (stringify + escrita atômica de 1,85 MB);
- projeção no teto `RASTREIO_LIMITE=50.000`: **1.287 ms e 14,7 MB por publicação**.

O ciclo de reenvio, porém, **não** é limitado pelo disco:

| Etapa | Tempo | Peso |
|---|---|---|
| Espera anti-rajada | 30–120 s | ~99 % |
| Envio Evolution (`sendText`) | ~4,4 s | ~1 % |
| Persistência JSON | ~0,3 s | **~0,1 %** |

Ou seja: **banco não acelera o reenvio**. O que ele resolve é outra coisa, e essa coisa
é real:

1. **Escala de escrita.** O modelo de arquivo único degrada linearmente e satura no teto.
2. **Consulta.** Filtrar 6.874 registros em memória funciona; 50 mil, não.
3. **Capacidade inexistente.** Hoje o que chega e **não** é encaminhado (duplicado,
   fora de janela, programa sem suporte, link inválido) é descartado — sobrevive apenas
   um SHA1 por 7 dias (`DEDUP_DIAS`). **Não há catálogo do que os grupos publicaram.**
   Sem catálogo não existe "filtrar o histórico e reenviar em lote".

## Decisão

### 1. SQLite via `node:sqlite` embutido — não Postgres, não um serviço novo

- `node:sqlite` **já existe** no runtime (Node ≥ 22.5). Zero dependência npm, zero
  container, zero porta, zero credencial. O `Dockerfile.manager` não muda.
- O Postgres que roda hoje (`evolution_pg_radar`) é **da Evolution e está isolado por
  desenho** (rede interna). Compartilhá-lo quebraria o isolamento; subir um Postgres
  dedicado é custo operacional sem contrapartida para um processo single-node.
- SQLite é **single-writer**. O manager é um processo único (`dist/manager/server.js`),
  então isso é uma vantagem (serialização grátis), não um limite. `WAL` +
  `busy_timeout=5000` cobrem os scripts e o smoke que abrem o arquivo em paralelo.

### 2. Ficar no Node 22 e isolar o acesso num único módulo

`node:sqlite` no Node 22 é **experimental** (emite `ExperimentalWarning`, API pode
mudar; estável no Node 24). Migrar a imagem base exigiria novo digest pinado em
`Dockerfile.manager` — passo operacional sem ganho imediato.

Mitigação: **todo** o acesso passa por `src/store/db.ts`. Trocar para Node 24 (ou para
`better-sqlite3`, ou para Postgres) = reescrever **um** arquivo.

### 3. Escopo em fases

| Fase | Entrega | Store |
|---|---|---|
| **1** | Catálogo de **toda** oferta recebida (inclusive a não encaminhada) | `ofertas` (novo) |
| **2** | Migrar o rastreio (`publicacoes.json`) | `publicacoes` |
| **3** | Reenvio em lote a partir do histórico | consome `ofertas` |
| **4** | Backup / health / migração no smoke | — |

### 4. O que **NÃO** vai para o banco (trava de contorno)

- **Dedup do Monitor** (`src/monitor/state.ts`): é um hash map em RAM, O(1), com reserva
  atômica síncrona antes de qualquer `await`. No banco ficaria **mais lento** e exigiria
  `BEGIN IMMEDIATE` + lock de escrita. Fica exatamente como está (NFR-002).
- **Broker da Mensageria** (`fila`/`DLQ`): já tem ACK / retry / DLQ com 321 testes.
  Trocar o transporte é risco alto com ganho zero.
- **`monitor-estado.json`** (eventos/contadores): pequeno, podado em 500 eventos.

### 5. Degradação segura

Se o banco não abrir (arquivo corrompido, permissão, `node:sqlite` indisponível), o
catálogo **desliga** e o fluxo do Monitor segue intacto: a gravação é *best-effort* e
**nunca** lança para o webhook. `/healthz` expõe o estado do banco.

## Consequências

### Positivas
- Histórico consultável de tudo o que os grupos publicaram (inclusive o descartado).
- Escrita de oferta deixa de reescrever 1,85 MB (177 ms → ~0,1 ms).
- Consulta filtrada com índice (~8 ms → ~0,07 ms).
- Base para reenvio em lote (Fase 3).
- Backup/restore = copiar um arquivo (`data/alcance.db`), já em bind mount.

### Negativas / riscos
- `node:sqlite` experimental no Node 22 (mitigado pelo adapter; considerar Node 24).
- Dois modelos de persistência convivem durante a migração (JSON + SQLite).
- `data/` não é versionado — o banco entra no script de backup, não no git.
- O arquivo cresce (~2 MB hoje; ~25 MB no teto de 50 mil, estimado).

## Alternativas descartadas

| Alternativa | Motivo da recusa |
|---|---|
| Continuar só em JSON | Satura no teto; sem catálogo do recebido |
| Postgres dedicado | Serviço, credencial e backup a mais para 1 processo |
| Postgres da Evolution | Quebra o isolamento por desenho |
| `better-sqlite3` | Dependência nativa (compilação na imagem) sem ganho sobre o embutido |
| Mover o dedup para o banco | Mais lento e perde a atomicidade síncrona |
| Mover o broker para o banco | Risco alto, ganho zero |

## Referências
- Benchmark JSON vs SQLite (medido em 2026-11-16, 6.874 registros): consulta filtrada
  8,1 ms → 0,07 ms; insert 177,5 ms → 0,05 ms; busca por PK 0,3 ms → 2,22 ms (JSON
  ganha em PK, perde em tudo o mais).
- `src/store/publicacoes.ts`, `src/store/json.ts`, `src/monitor/state.ts`.
- ADR-011 (padrão de port/adapter — mesmo raciocínio aplicado à persistência).
