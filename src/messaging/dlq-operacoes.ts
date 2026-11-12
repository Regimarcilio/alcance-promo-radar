/**
 * AÇÕES DA DLQ — o que o operador pode fazer com uma mensagem morta.
 *
 * Três ações, todas **explícitas** (nada volta sozinho):
 * - **reprocessar**: devolve o item para a fila de origem;
 * - **reprocessar em lote**: devolve vários itens (por tipo ou por lista de
 *   ids), respeitando o filtro visível na tela;
 * - **descartar**: remove o item da DLQ — **destrutivo**, sem volta.
 *
 * Regras que valem para as três:
 * - o item volta com `tentativas: 0` (o consumidor conta do zero), **mas**
 *   preserva o `ultimoErro` (auditoria) e incrementa `reprocessos`;
 * - **nada é enviado aqui**: o lote só **reenfileira**. Os itens seguem o
 *   ritmo normal da fila (1 a cada `CLIENTES_INTERVALO_S`, dentro da janela
 *   comercial) — reprocessar em lote **não** vira rajada;
 * - toda ação fica registrada na auditoria (`data/auditoria-mensageria.json`)
 *   com tipo, chave, motivo e `correlationId`.
 */
import { getBroker } from "./broker.js";
import { itensDlq } from "./filas.js";
import { removerDlq, type ItemDLQ } from "./dlq.js";
import { registrarAuditoriaAcao } from "./consumidores.js";
import { TIPO_MONITOR, reprocessarDlq } from "../monitor/fila.js";

/** Resultado padrão de uma ação sobre a DLQ. */
export interface ResultadoAcaoDlq {
  ok: boolean;
  /** erro (quando `ok` é falso) */
  erro?: string;
  /** quantos itens foram afetados */
  total: number;
  /** itens afetados (id + tipo) */
  itens?: { id: string; tipo: string }[];
  /** quantidade por tipo de fila */
  porTipo?: Record<string, number>;
}

/** Item da DLQ pelo id (procura em todos os tipos). */
export function itemNaDlq(id: string): ItemDLQ | null {
  const alvo = String(id ?? "").trim();
  if (!alvo) return null;
  return itensDlq().find((i) => i.id === alvo) ?? null;
}

/**
 * Remove o item da DLQ (**ação destrutiva** — a mensagem não volta para a
 * fila). Registra a ação na auditoria.
 */
export function descartarItemDlq(id: string): ResultadoAcaoDlq {
  const item = itemNaDlq(id);
  if (!item) return { ok: false, erro: "item não encontrado na DLQ", total: 0 };
  const removido = removerDlq(item.id);
  if (!removido) return { ok: false, erro: "item não encontrado na DLQ", total: 0 };
  registrarAuditoriaAcao({
    acao: "descartar",
    tipo: item.tipo,
    id: item.id,
    chave: item.envelope?.chave ?? null,
    motivo: item.motivo,
    correlationId: item.envelope?.correlationId ?? null,
    tentativas: item.tentativas,
    reprocessos: Number(item.envelope?.reprocessos ?? 0),
  });
  return { ok: true, total: 1, itens: [{ id: item.id, tipo: item.tipo }] };
}

/**
 * Devolve o item da DLQ para a fila de origem.
 *
 * O item volta **enfileirado** (não enviado): o consumidor o processa no
 * ritmo normal da fila. `tentativas` zera, `ultimoErro` é preservado e
 * `reprocessos` é incrementado.
 */
export async function reprocessarItemDlq(
  id: string,
  opts: { acao?: string } = {},
): Promise<ResultadoAcaoDlq> {
  const item = itemNaDlq(id);
  if (!item) return { ok: false, erro: "item não encontrado na DLQ", total: 0 };
  const acao = opts.acao ?? "reprocessar";

  if (item.tipo === TIPO_MONITOR) {
    // A fila do Monitor tem store próprio: o item volta para `data/monitor-fila.json`.
    const payload = item.envelope?.payload as any;
    if (!payload?.item) {
      return { ok: false, erro: "item da DLQ sem payload reconhecível", total: 0 };
    }
    const ok = reprocessarDlq(item.id);
    if (!ok) return { ok: false, erro: "não foi possível reprocessar o item", total: 0 };
  } else {
    const broker = getBroker();
    await broker.reprocessar(item.id);
    // confirma que o envelope voltou para a fila (a DLQ não pode "engolir" o item)
    const naFila = (broker.pendentes?.(item.tipo) ?? []).some((e) => e.id === item.id);
    if (!naFila) return { ok: false, erro: "não foi possível reprocessar o item", total: 0 };
  }

  registrarAuditoriaAcao({
    acao,
    tipo: item.tipo,
    id: item.id,
    chave: item.envelope?.chave ?? null,
    motivo: item.motivo,
    correlationId: item.envelope?.correlationId ?? null,
    tentativas: item.tentativas,
    reprocessos: Number(item.envelope?.reprocessos ?? 0) + 1,
  });
  return { ok: true, total: 1, itens: [{ id: item.id, tipo: item.tipo }] };
}

/** Filtro do reprocessamento em lote. */
export interface FiltroLoteDlq {
  /** reprocessa só os itens deste tipo de fila */
  tipo?: string | null;
  /** reprocessa só estes ids (o filtro por tipo também vale, se vier junto) */
  ids?: string[] | null;
}

/**
 * Reprocessa **vários** itens da DLQ de uma vez.
 *
 * Sem `tipo` nem `ids`: reprocessa tudo. Com `tipo`: só os itens daquele
 * tipo (é o filtro visível na tela). Com `ids`: só os indicados.
 *
 * De novo: o lote só **reenfileira** — o envio continua no ritmo normal da
 * fila (1 a cada `CLIENTES_INTERVALO_S`), nunca em rajada.
 */
export async function reprocessarLoteDlq(filtro: FiltroLoteDlq = {}): Promise<ResultadoAcaoDlq> {
  const todos = itensDlq();
  const ids = Array.isArray(filtro.ids) ? filtro.ids.map((i) => String(i).trim()).filter(Boolean) : [];
  const tipo = filtro.tipo ? String(filtro.tipo).trim() : "";

  let alvo = todos;
  if (ids.length) {
    const set = new Set(ids);
    alvo = alvo.filter((i) => set.has(i.id));
  }
  if (tipo) alvo = alvo.filter((i) => i.tipo === tipo);

  const porTipo: Record<string, number> = {};
  const afetados: { id: string; tipo: string }[] = [];
  for (const item of alvo) {
    const r = await reprocessarItemDlq(item.id, { acao: "reprocessar-lote" });
    if (!r.ok) continue;
    afetados.push({ id: item.id, tipo: item.tipo });
    porTipo[item.tipo] = (porTipo[item.tipo] ?? 0) + 1;
  }
  return { ok: true, total: afetados.length, itens: afetados, porTipo };
}
