/**
 * POLÍTICA de falha: retry com backoff exponencial + jitter e DLQ.
 *
 * Regras (material da aula de Mensageria):
 * - falha **transitória** (`Connection Closed`, 5xx, timeout, `ECONNRESET`…)
 *   → retry com backoff exponencial e **jitter** (evita rajada);
 * - falha **não transitória** (número inválido, mídia rejeitada, 400
 *   definitivo) → **direto para a DLQ**, sem retry (retry de erro
 *   permanente só queima janela);
 * - tentativas esgotadas → **DLQ** com o motivo e o número de tentativas.
 *
 * Backoff: `base * 2^(tentativas-1)`, teto `max`, jitter de ±20%.
 * Defaults: base 30s, teto 30 min, 3 tentativas (preserva o retry atual da
 * fila do Monitor).
 */
import { ehErroTransitorio } from "../wa/dispatch.js";
import type { Envelope } from "./envelope.js";
import type { ContextoNack, PoliticaNack } from "./broker.js";
import type { ItemDLQ } from "./dlq.js";

export interface OpcoesRetry {
  /** base do backoff (ms). Default 30s. */
  baseMs?: number;
  /** teto do backoff (ms). Default 30 min. */
  maxMs?: number;
  /** nº máximo de tentativas (a última tentativa ainda vai para a DLQ). */
  maxTentativas?: number;
  /** jitter relativo (±0.2 = ±20%). */
  jitter?: number;
  /** fonte de aleatoriedade (injetável para teste determinístico). */
  aleatorio?: () => number;
}

export interface RetryPadrao {
  baseMs: number;
  maxMs: number;
  maxTentativas: number;
  jitter: number;
  aleatorio: () => number;
}

/** Configuração de retry vinda do ambiente (com defaults seguros). */
export function opcoesRetry(): RetryPadrao {
  const base = Number(process.env.MENSAGERIA_RETRY_BASE_MS ?? 30_000);
  const max = Number(process.env.MENSAGERIA_RETRY_MAX_MS ?? 1_800_000);
  const tent = Number(process.env.MENSAGERIA_MAX_TENTATIVAS ?? 3);
  const jit = Number(process.env.MENSAGERIA_RETRY_JITTER ?? 0.2);
  return {
    baseMs: Number.isFinite(base) && base > 0 ? base : 30_000,
    maxMs: Number.isFinite(max) && max > 0 ? max : 1_800_000,
    maxTentativas: Number.isFinite(tent) && tent > 0 ? Math.floor(tent) : 3,
    jitter: Number.isFinite(jit) && jit >= 0 ? jit : 0.2,
    aleatorio: Math.random,
  };
}

/**
 * Intervalo até a próxima tentativa: `base * 2^(tentativas-1)`, com jitter de
 * ±`jitter` e teto em `maxMs`.
 */
export function intervaloRetry(tentativas: number, op: OpcoesRetry = {}): number {
  const o: RetryPadrao = { ...opcoesRetry(), ...op };
  const t = Math.max(1, Math.floor(tentativas));
  const bruto = Math.min(o.maxMs, o.baseMs * Math.pow(2, t - 1));
  const fator = 1 + o.jitter * (o.aleatorio() * 2 - 1);
  return Math.max(0, Math.min(o.maxMs, Math.round(bruto * fator)));
}

/** ISO do momento da próxima tentativa. */
export function proximaTentativaEm(tentativas: number, op: OpcoesRetry = {}): string {
  return new Date(Date.now() + intervaloRetry(tentativas, op)).toISOString();
}

/** O erro vale um retry? (transitório e ainda há tentativas) */
export function deveRetentar(erro: string, tentativas: number, op: OpcoesRetry = {}): boolean {
  const o: RetryPadrao = { ...opcoesRetry(), ...op };
  return ehErroTransitorio(erro) && tentativas <= o.maxTentativas;
}

/** Origem do envelope (disparo/lista) usada na DLQ. */
export function origemDoEnvelope(env: Envelope): string | null {
  const payload = env.payload as any;
  const origem = payload?.disparoId ?? payload?.origem ?? null;
  return origem ? String(origem) : null;
}

/**
 * Política padrão de `nack`: re-enfileira com backoff ou manda para a DLQ.
 * É o gancho usado pelas filas de Clientes e do Monitor.
 */
export function politicaPadrao(op: OpcoesRetry = {}): PoliticaNack {
  return async (ctx: ContextoNack) => {
    const transitorio = ehErroTransitorio(ctx.erro);
    if (deveRetentar(ctx.erro, ctx.tentativas, op)) {
      const env: Envelope = {
        ...ctx.envelope,
        proximaTentativaEm: proximaTentativaEm(ctx.tentativas, op),
      };
      delete env.emAndamento;
      delete env.reservadoEm;
      await ctx.reenfileirar(env);
      return;
    }
    const item: ItemDLQ = {
      id: ctx.envelope.id,
      tipo: ctx.tipo,
      envelope: ctx.envelope,
      motivo: transitorio ? "tentativas esgotadas" : "erro não transitório",
      ultimoErro: ctx.erro,
      tentativas: ctx.tentativas,
      ultimaTentativaEm: new Date().toISOString(),
      origem: origemDoEnvelope(ctx.envelope),
    };
    await ctx.paraDlq(item);
  };
}
