/**
 * FILAS — visão agregada das filas da camada de Mensageria (usada pela API).
 *
 * Junta o que vem do broker (fila de Clientes) e o que vem da fila do
 * Monitor (store próprio, mas com a mesma semântica de ACK/DLQ) num único
 * retrato: pendentes, processadas, falhas, DLQ e a idade da mais antiga.
 *
 * Nota de camada: este módulo é a **ponte** entre a mensageria e o Monitor
 * (único ponto que conhece os dois lados) — o resto da mensageria não depende
 * do Monitor.
 */
import { getBroker } from "./broker.js";
import { lerDlq, tiposComDlq } from "./dlq.js";
import type { ItemDLQ } from "./dlq.js";
import { TIPO_CLIENTE } from "../clientes/fila.js";
import { TIPO_MONITOR, dlqMonitor, statsMonitor } from "../monitor/fila.js";

export interface ResumoFila {
  tipo: string;
  pendentes: number;
  processadas: number;
  falhas: number;
  dlq: number;
  maisAntigaEm: string | null;
  /** idade da mensagem mais antiga na fila (ms) */
  idadeFilaMs: number;
  /** taxa de erro (falhas / (processadas + falhas)) */
  taxaErro: number;
}

/** Retrato de todas as filas conhecidas (base das métricas e do /stats). */
export function resumoFilas(): ResumoFila[] {
  const broker = getBroker();
  const tipos = [TIPO_CLIENTE, TIPO_MONITOR];
  return tipos.map((tipo) => {
    const base = tipo === TIPO_MONITOR ? statsMonitor() : broker.stats(tipo);
    const idade = base.maisAntigaEm ? Date.now() - Date.parse(base.maisAntigaEm) : 0;
    const total = base.processadas + base.falhas;
    return {
      tipo,
      ...base,
      idadeFilaMs: Number.isFinite(idade) && idade > 0 ? Math.round(idade) : 0,
      taxaErro: total > 0 ? Number((base.falhas / total).toFixed(4)) : 0,
    };
  });
}

/** Itens da DLQ (de um tipo ou de todos). */
export function itensDlq(tipo?: string | null): ItemDLQ[] {
  if (tipo) return lerDlq(tipo);
  const todos = tiposComDlq().flatMap((t) => lerDlq(t));
  if (!todos.some((i) => i.tipo === TIPO_MONITOR)) return todos;
  return todos;
}

/** Itens da DLQ do Monitor (fila própria, fora do broker). */
export function dlqDoMonitor(): ItemDLQ[] {
  return dlqMonitor();
}
