# Duplicata que volta para a fila precisa de marcador no envelope

## Sintoma
A idempotência do consumidor **descartava** a duplicata (ACK sem reenviar). O pedido do
operador foi outro: a duplicata deve **voltar para a fila** 24h depois do lançamento, passando
de novo pelo ritmo da Mensageria.

## Armadilha 1 — o reenvio se reagenda em loop
Sem marcador, o reenvio é processado como uma duplicata "comum" e é reagendado de novo
(loop infinito de +24h). **Regra**: a duplicata reagendada recebe um marcador
(`reenvio: {originalEm, agendadoEm, chave}`) e o consumidor **pula a checagem de idempotência**
quando ele existe. O marcador também viaja no retry/DLQ (então o reenvio é **único**: uma falha
segue o backoff normal, sem novo +24h).

## Armadilha 2 — o relógio
"As 24h contam do **lançamento original** (o `timestamp` do envelope), não da detecção". Se o
ciclo de N horas já passou, o alvo **rola para o próximo ciclo** (`alvo += N horas`), para nunca
ficar no passado — lançado ontem 08:00 e detectado hoje 10:00 vai para **amanhã 08:00**.

## Armadilha 3 — a chave de negócio define o efeito colateral
O Monitor não tem chave de item: a chave é o **hash da oferta** (`mlbId|preco|cupom`, o mesmo
do Piloto). Logo, "duplicata" ali significa **a mesma oferta** — e a mesma oferta volta aos
grupos 24h depois. É preciso: (a) avisar o operador (ADR/README) e (b) deixar o comportamento
**configurável por tipo** (`MENSAGERIA_REENVIO_DUP_TIPOS`), para desligar o efeito colateral sem
mexer em código. Sem id de produto não há chave confiável (colidiria entre ofertas diferentes) —
melhor não tratar como duplicata.

## Padrão adotado
1. Núcleo genérico e testável (`agendarReenvioDuplicado`, `ehReenvioAgendado`,
   `reenvioPermitido`) separado dos consumidores.
2. O reagendamento **não é ACK**: o item continua na fila com `proximaTentativaEm` — a fila
   continua responsável por janela comercial, anti-rajada e retry/DLQ (nunca envio avulso).
3. `correlationId` e chave preservados no reenvio (rastreabilidade do fluxo original).
4. Observabilidade: contadores de duplicata reagendada, de reenvio realizado, gauge do aging e
   evento de "reagendada" (visível no painel com badge de origem).

## Armadilha 4 — reagendar não pode travar a fila
No Monitor a fila tem uma **flag de store** (`emAndamento`) que trava a liberação enquanto um
item está em envio. O caminho de reagendamento devolve o item à fila **sem** passar pelo ACK:
se a flag não for limpa no mesmo caminho, a fila inteira para de enviar (até o próximo
restart). **Regra**: o item reagendado precisa sair de `emAndamento` junto com o reagendamento —
e o teste tem que provar que a **próxima** oferta da fila ainda é enviada (não basta provar que
o item reagendado ficou na fila).

## Armadilha 5 — o filtro de recepção vem antes da chave de negócio
No Monitor o consumidor agora compara a chave de negócio da oferta, mas **antes** dele roda o
filtro de recepção (RF-035: produto/origem, 7 dias). Ou seja: a duplicata só chega ao consumidor
(é vista como duplicata de negócio) quando passa por esse filtro — depois da retenção dele, ou
vinda de outra origem. **Regra**: ao documentar "a mesma oferta volta 24h depois", dizer **por
qual caminho** ela chega; e não mexer no filtro de recepção sem o operador pedir (é filtro de
seleção pré-publicação, não idempotência de mensagem em fila).

## Evidência
- Issue #78 / PR #80; `src/messaging/reenvio.test.ts` (7 testes), `src/clientes/clientes.test.ts`
  (+5) e `src/monitor/fila.test.ts` (+6) — 300/300 verdes.
- Revisão do MASTER: os 2 testes extras do Monitor provam que a duplicata reagendada **não
  trava a fila** e que o reenvio é enviado **uma única vez** (caminho natural, sem
  `reenfileirar`) — o `reenfileirar` mascara o estado da fila e escondia a armadilha 4.

## Regra geral
Reagendar não é "reenviar depois": é **devolver o item à fila com um novo momento**, marcado
para que o próprio reenvio não se detecte como duplicata. E o relógio do reagendamento é sempre
o **lançamento**, não a detecção.

E, quando o enunciado e a decisão do operador se contradizem (aqui: o cenário Gherkin dizia
"10:00 → 18:00" e a decisão dizia "24h do lançamento"), **prevalece a decisão do operador** — e o
conflito fica documentado no PR, não escondido no código.
