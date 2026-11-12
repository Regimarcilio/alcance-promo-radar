# Protótipo — Mensageria: filas + DLQ + Reprocessar

**Status**: **aprovado** pelo operador em **2026-11-12** · **implementado** no PR da **issue #54**.

> Este é o **protótipo** da view Mensageria do painel (issue #53). O operador **aprovou**
> a opção 1 com a instrução *"implementar para uso"*, o que liberou a **issue #54**
> (implementação da interface no painel real).
>
> A implementação saiu no **PR da #54** (`src/manager/server.ts`): a view Mensageria do
> painel real segue **este protótipo** — mesmos KPIs, mesma tabela de filas, mesma tabela
> de DLQ (motivo colorido, Reprocessar / Reprocessar tudo / Descartar), mesma trilha de
> correlação em gaveta lateral, mesmos estados (vazio, carregando, erro de API, item em
> reprocessamento) e o mesmo vocabulário visual (`.panel`, `.kpi`, `.mbtn`, `.mini`).
>
> Evidência da implementação em execução:
> [`implementacao-view-mensageria.png`](implementacao-view-mensageria.png) e
> [`implementacao-trilha-correlacao.png`](implementacao-trilha-correlacao.png).

## Objetivo

Dar ao operador uma **view nova** no menu lateral do painel — **Mensageria**, ao lado de
Contas, Cupons, Piloto, Monitor, Números, Rastreio e Clientes — onde ele:

1. **enxerga o estado das filas** (pendentes, processadas, falhas, DLQ, taxa de erro, idade
   da mensagem mais antiga) sem precisar de Grafana nem de log;
2. **vê o que falhou de vez** (a DLQ) e **repara na hora**: reprocessar uma mensagem
   solta, reprocessar tudo de uma fila, ou descartar de vez;
3. **prova o rastreio ponta a ponta** — clicando num item, vê a trilha do `correlationId`
   (publicado → processado → erro → DLQ).

As abas existentes (Clientes, Monitor, Números, Rastreio) **não são redesenhadas**: a
Mensageria é uma **view nova**, ao lado delas. O redesign da aba Números segue fora de
escopo, por decisão do operador.

## Arquivos

| Arquivo | Mostra |
|---|---|
| `opcao-1.html` | protótipo **navegável e autocontido** (abre direto no navegador, sem build e sem servidor): KPIs, listas de filas por tipo, tabela da DLQ com Reprocessar / Reprocessar tudo / Descartar, trilha de correlação, tópicos/assinantes, eventos recentes e os 8 estados obrigatórios — **referência visual da implementação (#54)** |
| `implementacao-view-mensageria.png` | a view **Mensageria implementada** no painel real (estado de rotina, com DLQ) |
| `implementacao-trilha-correlacao.png` | a **gaveta de trilha de correlação** da implementação real |

O HTML é **100% autocontido**: CSS e JS embutidos, **zero** recursos externos (sem CDN,
sem fonte remota, sem imagem). Funciona em `file://` — não precisa de servidor nem de
build. Verificado em navegador (Chromium): abre sem erro de console e sem recurso
externo quebrado.

## Como abrir

```bash
# abre direto no navegador (funciona em file://)
xdg-open docs/prototipos/mensageria/opcao-1.html

# ou, se preferir servir por HTTP
python3 -m http.server 8765
# depois: http://localhost:8765/docs/prototipos/mensageria/opcao-1.html
```

Na primeira tela há um seletor **“Cenário do protótipo”** (topo da área de conteúdo) que
troca entre os estados — é por ele que se navega pelos estados obrigatórios.

## Parâmetros

- **Visual**: herda o painel real (`src/manager/server.ts`): fundo em gradiente `--bg`,
  cards `--card`, bordas `--border`, botões `.mbtn` / `.mbtn.ok`, tomadores `.mini`,
  KPIs `.kpi` (com faixa lateral colorida), tabelas `.tbl` dentro de `.tblwrap`,
  alertas `.alerta`, seletor de tema no topo.
- **Paleta de referência**: **verde** (`--primary #047857`, `--accent #0f766e`,
  `--tertiary #65a30d`, gradiente `#0f766e → #047857`). As **6 paletas** do painel
  (verde, laranja, areia, grafite, marrom, cacau) estão no seletor de tema e persistem
  em `localStorage` — como no painel real.
- **Tipografia**: `system-ui` 14px no corpo; 12,5px nas tabelas; 9,5px em caixa alta nos
  cabeçalhos; monospace (`ui-monospace`) em chaves e `correlationId`.
- **Layout**: sidebar de 258px (como o painel) + conteúdo de até 1160px. Breakpoints em
  980px (sidebar vira barra horizontal) e 700px (sidebar vira faixa rolável, tabelas
  reduzem a fonte).
- **Dados**: **100% fictícios** (LGPD) — JIDs `551900000000N@s.whatsapp.net`, nomes
  “Contato Demo”, “Grupo Demo Origem”, produtos `MLB-902xx`. Nenhum dado real de cliente.
- **Tabela da DLQ**: `table-layout: fixed` com larguras por coluna (tipo, chave/correlação,
  motivo, tentativas, última tentativa, origem, último erro, ações) — cabe em 1440px
  **sem rolagem lateral**.

## Dados de exemplo — formato idêntico ao real

O protótipo **não inventa campos**. As formas seguem os payloads das APIs que já estão no
ar (container `automensagem_manager`, porta 8091, `X-Manager-Key`):

| Endpoint | Forma usada no protótipo |
|---|---|
| `GET /api/mensageria/stats` | `{ filas: [{ tipo, pendentes, processadas, falhas, dlq, maisAntigaEm, idadeFilaMs, taxaErro }] }` |
| `GET /api/mensageria/filas` | mesma forma de `filas` |
| `GET /api/mensageria/dlq` | `{ itens: [{ id, tipo, envelope: {...}, motivo, ultimoErro, tentativas, ultimaTentativaEm, origem }] }` |
| `GET /api/mensageria/eventos` | `{ eventos: [{ em, tipo, id, correlationId, chave, tentativas }], assinantes: [{ tipo, nome, pendentes }] }` |
| `POST /api/mensageria/dlq/reprocessar` | `{ id }` → `{ ok: true }` |

Tipos de fila: `cliente.enviar`, `monitor.encaminhar`, `monitor.add-grupo` (este último
declarado em `TIPOS_MENSAGEM`, ainda sem produtor ativo — por isso aparece zerado).

Eventos: `oferta.recebida`, `disparo.criado`, `disparo.concluido`,
`disparo.mensagem.enviada`, `instancia.conectada`, `instancia.desconectada`,
`mensagem.dlq`.

Motivos canônicos da DLQ: `erro não transitório` (badge vermelho) e `tentativas esgotadas`
(badge âmbar) — os mesmos de `src/messaging/dlq.ts`.

## Estados obrigatórios cobertos

Seletor **“Cenário do protótipo”** (8 cenários):

| Cenário | O que mostra |
|---|---|
| **Normal** | filas em operação, DLQ com 4 itens — estado de rotina |
| **Fila vazia** | tudo zerado, DLQ limpa + alerta “Nenhuma mensagem pendente” |
| **Fila grande** | 569 pendentes, taxa de erro 4,31%, fila antiga — incidente |
| **DLQ vazia** | filas trabalhando, nada falhou de vez (estado “Nada na DLQ”) |
| **DLQ com muitos itens** | 10 mensagens falhas para reprocessar ou descartar |
| **Item em reprocessamento** | spinner no botão, linha destacada, item travado na DLQ |
| **Erro de API** | banner de erro com ação **Tentar de novo** + estados vazios em cada painel |
| **Carregando** | esqueletos (skeleton) nos KPIs, nas tabelas de filas e na de DLQ |

## Ações

| Ação | Onde | Comportamento no protótipo |
|---|---|---|
| **Reprocessar** (item) | coluna *Ações* da DLQ e o rodapé da trilha | item sai da DLQ, `dlq` da fila −1, `pendentes` +1, toast de confirmação |
| **Reprocessar tudo** | botão no painel da DLQ | respeita o filtro de tipo e a busca; **modal de confirmação** com a contagem exata |
| **Descartar** (item) | coluna *Ações* da DLQ | **modal de confirmação** explícito; item sai da DLQ, `dlq` da fila −1, não volta para a fila |
| **Trilha de correlação** | botão 🔗 por item e por evento | abre uma gaveta lateral com as etapas do `correlationId` |
| **Atualizar** | painel de filas | simula nova leitura do snapshot |
| **Copiar chave** | botão ⧉ na coluna de chave | copia a chave de idempotência |

## Decisões visuais

- **View nova, não redesenho**: *Mensageria* entra como item novo do menu lateral, com
  badge com o número de itens na DLQ (como as demais abas). As outras abas ficam intactas.
- **KPIs no topo, DLQ no meio**: a ordem é leitura → diagnóstico → ação. Os KPIs
  respondem “está tudo bem?”; a tabela responde “o que quebrou e o que eu faço?”.
- **Motivo colorido**: `erro não transitório` em vermelho (não adianta retry — precisa de
  intervenção) e `tentativas esgotadas` em âmbar (retry pode resolver). A cor carrega a
  decisão, não só o texto.
- **Trilha em gaveta lateral, não modal**: a trilha é consulta — não deve bloquear a
  tabela. E o rodapé da gaveta mantém o *Reprocessar* ao alcance, fechando o ciclo
  consultar → reparar.
- **Reprocessar tudo é por filtro**: o botão age sobre o que está **visível** (tipo
  selecionado + busca). O modal diz exatamente quantas mensagens serão reprocessadas,
  para nunca ser uma ação às cegas.
- **Descartar é destrutivo e não tem volta**: por isso exige confirmação explícita, com o
  id da mensagem e o aviso de que ela **não volta para a fila**.
- **Dados fictícios marcados**: o selo “dados fictícios” fica sempre visível no seletor
  de cenário — ninguém confunde o protótipo com operação real.
- **Reprodutibilidade**: o mesmo seletor de tema do painel (6 paletas) e o mesmo
  vocabulário de botões (`.mbtn`, `.mbtn.ok`) — o protótipo **parece parte do produto**.

## Pendências / riscos — resolvidas na #54

1. **Aprovação do operador** — ✅ feita em 2026-11-12 ("implementar para uso"); liberou a #54.
2. **Endpoint de descarte** — ✅ `POST /api/mensageria/dlq/descartar` `{ id }`: remove o item
   da DLQ (destrutivo), **não** devolve para a fila e registra a ação na auditoria
   (`data/auditoria-mensageria.json`) com tipo, chave, motivo e `correlationId`.
3. **Reprocessamento em lote** — ✅ `POST /api/mensageria/dlq/reprocessar-lote` `{ tipo?, ids? }`:
   reprocessa o que está **visível** na tela (filtro por tipo + busca). O lote **só
   reenfileira** — os itens voltam com `tentativas: 0`, `ultimoErro` preservado e
   `reprocessos++`, e seguem o ritmo normal da fila (1 a cada `CLIENTES_INTERVALO_S`):
   **não vira rajada**.
4. **Busca e filtro** — ✅ mantidos no cliente (sobre o snapshot), como no protótipo; a
   triagem por tipo também é enviada ao servidor no reprocessamento em lote.
5. **`monitor.add-grupo`** — continua aparecendo zerado (tipo declarado, sem produtor
   ativo): é o comportamento esperado.
6. **Trilha a partir de qualquer evento** — ✅ o botão 🔗 existe nos itens da DLQ **e** nos
   eventos recentes; a trilha usa `GET /api/mensageria/eventos?correlationId=…` (filtro
   novo, criado na #54) e mostra as **ações do operador** (reprocessar/descartar) no fim.

## O que a implementação acrescentou (além do protótipo)

- `POST /api/mensageria/dlq/descartar` e `POST /api/mensageria/dlq/reprocessar-lote`
  (rotas novas, *default-deny* como as demais).
- `GET /api/mensageria/eventos?correlationId=…` — filtro de correlação (a trilha depende
  dele) e o bloco `acoes` (ações do operador) separado dos eventos.
- Auditoria das ações do operador (`registro: "acao"`), com `tipo`, `chave`, `motivo` e
  `correlationId` — é o rastro das ações destrutivas.
- `reprocessos` no envelope: quantas vezes a mensagem foi reparada pelo operador.
