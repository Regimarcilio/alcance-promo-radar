# ADR-006 — Multi-número: rodízio ponderado com principal para serviços

> Data: 2026-10-22 | Atualizado: 2026-10-23 | Status: Aceita (implementada; `src/wa/rotacao.test.ts` verde)

## Contexto

Enviar ofertas sempre do mesmo número WhatsApp é o caminho mais rápido para o banimento: o volume
concentrado dispara a heurística anti-spam da plataforma. Ao mesmo tempo, operações de grupo
(adicionar contatos, mexer em permissões) exigem uma conta **administradora** do grupo — não podem
ser diluídas em qualquer número.

Era preciso, então, distribuir o **envio** entre vários celulares para reduzir o risco por número,
sem perder a estabilidade das ações de serviço que dependem de um número "de casa".

## Decisão

**Cadastro de instâncias** (`src/wa/rotacao.ts`)
- Máximo de **5 números** (`MAX_INSTANCIAS`) pareados na Evolution, persistidos em
  `data/instancias.json` com `instancia`, `nome`, `ativo`, `peso`, `enviadas`, `ultimaEm` e
  `principal`.
- Cada instância tem **peso de 1 a 10** — números mais "quentes" podem receber mais volume.
- Estado de conexão é cacheado por 45s (`TTL_ESTADO`) para não consultar a Evolution a cada envio.

**Escolha do remetente de envio**
- Só entram candidatos **ativos** e com conexão `open`; se nenhum estiver `open`, ainda se sorteia um
  ativo (o retry do dispatch cobre a falha transitória).
- **Todos os abertos enviam**: o **principal** e os **secundários** participam do **envio de
  mensagens**; o peso de cada número define sua fatia no rodízio. O principal não fica reservado
  ao serviço.
- O **principal** continua sendo o **preferido para operações de serviço** (adicionar contatos,
  permissões de grupo) — é o número "de casa" para ações administrativas.
- Se um número falha, o dispatch repete em outra instância; se **nenhum** estiver `open`, ainda
  sorteia um ativo — nada fica sem enviar.
- O envio é **rodízio aleatório ponderado** pelo peso, com **anti-repetição**: a última instância
  usada é descartada com probabilidade `RODIZIO_EVITA_REPETICAO` (default `0.7`) quando há outra
  disponível.

**Serviço vs. envio**
- `instanciaParaServico()` devolve sempre o principal (mesmo se `closed`, com aviso no log) — as
  ações de serviço dependem dele.
- O dispatch de mensagens (`src/wa/dispatch.ts`) usa a rotação e faz até **3 tentativas** em falhas
  transitórias, trocando de instância quando possível.

## Consequências

- **+** Volume de envio distribuído entre todos os números abertos: cada um carrega uma fração,
  reduzindo risco de bloqueio por concentração.
- **+** Ações de serviço ficam concentradas no número administrador — menos falhas de permissão.
- **+** Envio não para se um número cai: os demais absorvem, inclusive o principal.
- **+** Pesos dão controle fino de volume por número sem editar código.
- **−** Sem limite diário por número no nível do app: a proteção depende da distribuição e do
  intervalo entre mensagens, não de uma cota rígida.
- **−** Se **todos** os números estiverem fora, o envio ainda tenta o principal e pode falhar — o
  operador precisa monitorar a aba Números.
- **−** Estado de conexão tem cache de 45s: um número recém-conectado pode demorar um pouco a entrar
  no rodízio.

## Referências

- Implementação: `src/wa/rotacao.ts`, `src/wa/dispatch.ts`
- Testes: `src/wa/rotacao.test.ts` (11)
- SRS: RF-042 (rotação com peso e principal), RF-054 (QR/reinício/desconexão); RN-016 (rotação)
- Issues: #28 (rotação multi-número; principal preferido para serviços)
