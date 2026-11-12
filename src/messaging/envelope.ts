/**
 * ENVELOPE — formato padronizado de toda mensagem que trafega na camada de
 * Mensageria (material da aula de 10/11/2026).
 *
 * O envelope é o CONTRATO entre produtor e consumidor: carrega identidade
 * (id), tipo do dado, versão do schema, momento de publicação, o
 * `correlationId` (rastreio ponta a ponta do fluxo), a chave de idempotência
 * (`chave`, opcional) e o número de tentativas de processamento.
 *
 * Regras:
 * - é **JSON puro** (sem Date, sem undefined): só strings e números;
 * - `versao` começa em 1 e só muda quando o shape do payload muda;
 * - `correlationId` é **herdado do contexto** quando não vem explícito
 *   (ver `comCorrelacao`), para que webhook → fila → envio → evento
 *   compartilhem o mesmo identificador de fluxo.
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

/** Versão atual do schema de envelope. */
export const VERSAO_ENVELOPE = 1;

export interface Envelope<T = unknown> {
  /** uuid gerado na publicação */
  id: string;
  /** tipo do dado: "cliente.enviar" | "monitor.encaminhar" | ... */
  tipo: string;
  /** versão do schema (começa em 1) */
  versao: number;
  /** ISO de publicação */
  timestamp: string;
  /** rastreia o fluxo ponta a ponta */
  correlationId: string;
  /** chave de idempotência (negócio) */
  chave?: string;
  /** nº de tentativas de processamento */
  tentativas: number;
  /** conteúdo da mensagem */
  payload: T;
}

export interface OpcoesEnvelope {
  correlationId?: string | null;
  chave?: string | null;
  versao?: number;
  tentativas?: number;
  id?: string;
  timestamp?: string;
}

/** Contexto de correlação do fluxo em execução (herdado entre chamadas). */
const contexto = new AsyncLocalStorage<string>();

/**
 * Executa `fn` com um `correlationId` no contexto: todo envelope criado
 * dentro dele herda o identificador (AC: "correlação herdada do contexto").
 */
export function comCorrelacao<T>(correlationId: string, fn: () => T): T {
  return contexto.run(correlationId, fn);
}

/** `correlationId` do contexto atual (ou null). */
export function correlacaoAtual(): string | null {
  return contexto.getStore() ?? null;
}

/** Schema zod do envelope (base da validação e dos testes). */
export function schemaEnvelope() {
  return z.object({
    id: z.string().min(1, "id obrigatório"),
    tipo: z.string().min(1, "tipo obrigatório"),
    versao: z.number().int().positive("versao deve ser positiva"),
    timestamp: z.string().min(1, "timestamp obrigatório"),
    correlationId: z.string().min(1, "correlationId obrigatório"),
    chave: z.string().min(1).optional(),
    tentativas: z.number().int().min(0, "tentativas não pode ser negativa"),
    payload: z.unknown(),
  });
}

/** Erro de envelope inválido — carrega os campos problemáticos. */
export class EnvelopeInvalidoError extends Error {
  readonly campos: string[];
  constructor(campos: string[], detalhe?: string) {
    super(
      `envelope inválido: campo(s) ${campos.join(", ")}${detalhe ? ` — ${detalhe}` : ""}`
    );
    this.name = "EnvelopeInvalidoError";
    this.campos = campos;
  }
}

/**
 * Cria um envelope novo.
 * - `id`/`timestamp`/`versao`/`tentativas` têm padrão;
 * - `correlationId` = explícito > contexto > novo uuid;
 * - `chave` só existe se informada (JSON puro).
 */
export function criarEnvelope<T>(tipo: string, payload: T, opts: OpcoesEnvelope = {}): Envelope<T> {
  const correlationId =
    (opts.correlationId ?? "").trim() || correlacaoAtual() || randomUUID();
  const env: Envelope<T> = {
    id: (opts.id ?? "").trim() || randomUUID(),
    tipo: String(tipo ?? "").trim(),
    versao: Number.isFinite(opts.versao as number) ? Number(opts.versao) : VERSAO_ENVELOPE,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    correlationId,
    tentativas: Number.isFinite(opts.tentativas as number) ? Math.max(0, Number(opts.tentativas)) : 0,
    payload,
  };
  const chave = (opts.chave ?? "").trim();
  if (chave) env.chave = chave;
  return env;
}

/**
 * Valida o envelope e devolve-o tipado. **Lança** `EnvelopeInvalidoError`
 * com o nome do campo faltante/inválido.
 */
export function validarEnvelope<T = unknown>(e: unknown): Envelope<T> {
  const parsed = schemaEnvelope().safeParse(e);
  if (parsed.success) return parsed.data as Envelope<T>;
  const campos = parsed.error.issues.map((i) => i.path.join(".") || "(raiz)");
  throw new EnvelopeInvalidoError(campos, parsed.error.issues[0]?.message);
}

/** Valida sem lançar — útil em checagens pontuais. */
export function envelopeValido(e: unknown): boolean {
  return schemaEnvelope().safeParse(e).success;
}
