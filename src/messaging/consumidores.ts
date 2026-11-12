/**
 * CONSUMIDORES padrão dos tópicos (fan-out real, sem coupling com o produtor).
 *
 * - **auditoria**: grava em `data/auditoria-mensageria.json` (append-only, sem
 *   PII — só tipo, id, correlação e resumo do payload);
 * - **métricas**: incrementa contadores (consumidos pelo Prometheus na #52);
 * - **log**: uma linha de log estruturada com o `correlationId`.
 *
 * Nenhum consumidor pode alterar o comportamento do produtor: eles só
 * leem. É o teste do desacoplamento.
 */
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";
import { logger } from "../observability/logger.js";
import { incrementar } from "./contadores.js";
import type { Envelope } from "./envelope.js";

/** Limite do log de auditoria (o mais antigo sai). */
export const LIMITE_AUDITORIA = 1000;

function arquivoAuditoria(): string {
  return join(dataDirAtual(), "auditoria-mensageria.json");
}

/**
 * Entradas da auditoria (append-only, retenção limitada).
 *
 * A auditoria guarda **dois tipos** de registro, distinguidos por `registro`:
 * - `"evento"`: o consumeor de um tópico viu o evento (fluxo do sistema);
 * - `"acao"`:  o **operador** agiu na DLQ (reprocessar / descartar) — é o
 *   rastro das ações destrutivas e precisa de tipo, chave, motivo e
 *   `correlationId`.
 */
export function lerAuditoria(): any[] {
  const raw = lerJson<any>(arquivoAuditoria(), []);
  return Array.isArray(raw) ? raw : [];
}

/** Só os eventos (sem as ações do operador). */
export function lerAuditoriaEventos(): any[] {
  return lerAuditoria().filter((e: any) => e?.registro !== "acao");
}

/** Só as ações do operador sobre a DLQ. */
export function lerAuditoriaAcoes(): any[] {
  return lerAuditoria().filter((e: any) => e?.registro === "acao");
}

function gravarAuditoria(arr: any[]): void {
  gravarJsonAtomico(arquivoAuditoria(), arr.slice(Math.max(0, arr.length - LIMITE_AUDITORIA)));
}

/** Registra um evento na auditoria (sem PII). */
export function registrarAuditoria(env: Envelope): void {
  const arr = lerAuditoria();
  arr.push({
    em: new Date().toISOString(),
    registro: "evento",
    tipo: env.tipo,
    id: env.id,
    correlationId: env.correlationId,
    chave: env.chave ?? null,
    tentativas: env.tentativas ?? 0,
  });
  gravarAuditoria(arr);
}

/** Ação do operador sobre a DLQ (reprocessar, reprocessar em lote, descartar). */
export interface RegistroAuditoriaAcao {
  /** ação executada: "reprocessar" | "reprocessar-lote" | "descartar" */
  acao: string;
  /** tipo da mensagem ("cliente.enviar", "monitor.encaminhar", ...) */
  tipo: string;
  /** id do envelope */
  id: string;
  /** chave de idempotência (se houver) */
  chave?: string | null;
  /** motivo canônico da DLQ ("tentativas esgotadas", "erro não transitório") */
  motivo?: string | null;
  /** correlação do fluxo (para a trilha do painel) */
  correlationId?: string | null;
  /** nº de tentativas que a mensagem acumulou antes da ação */
  tentativas?: number;
  /** quantas vezes a mensagem já foi reprocessada */
  reprocessos?: number;
}

/**
 * Registra uma **ação do operador** na auditoria da Mensageria.
 *
 * É o rastro das ações destrutivas: `descartar` (some com a mensagem) e
 * `reprocessar` (a mensagem volta para a fila) ficam com tipo, chave, motivo
 * e `correlationId` — o mesmo formato lido pelo painel.
 */
export function registrarAuditoriaAcao(r: RegistroAuditoriaAcao): void {
  const arr = lerAuditoria();
  arr.push({
    em: new Date().toISOString(),
    registro: "acao",
    acao: r.acao,
    tipo: r.tipo,
    id: r.id,
    chave: r.chave ?? null,
    motivo: r.motivo ?? null,
    correlationId: r.correlationId ?? null,
    tentativas: r.tentativas ?? 0,
    reprocessos: r.reprocessos ?? 0,
  });
  gravarAuditoria(arr);
}

/** Consumidor de auditoria. */
export async function consumidorAuditoria(env: Envelope): Promise<void> {
  registrarAuditoria(env);
}

/** Consumidor de log (linha estruturada com o correlationId). */
export async function consumidorLog(env: Envelope): Promise<void> {
  logger.info(
    { evento: env.tipo, correlationId: env.correlationId, chave: env.chave ?? null, id: env.id },
    "mensageria: evento",
  );
}

/** Consumidor de métricas (contadores). */
export async function consumidorMetricas(env: Envelope): Promise<void> {
  incrementar("alcance_msg_eventos_total", { tipo: env.tipo });
}
