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

/** Entradas da auditoria (append-only, retenção limitada). */
export function lerAuditoria(): any[] {
  const raw = lerJson<any>(arquivoAuditoria(), []);
  return Array.isArray(raw) ? raw : [];
}

/** Registra um evento na auditoria (sem PII). */
export function registrarAuditoria(env: Envelope): void {
  const arr = lerAuditoria();
  arr.push({
    em: new Date().toISOString(),
    tipo: env.tipo,
    id: env.id,
    correlationId: env.correlationId,
    chave: env.chave ?? null,
    tentativas: env.tentativas ?? 0,
  });
  gravarJsonAtomico(arquivoAuditoria(), arr.slice(Math.max(0, arr.length - LIMITE_AUDITORIA)));
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
