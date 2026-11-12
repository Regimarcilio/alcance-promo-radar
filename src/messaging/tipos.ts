/**
 * CATÁLOGO DE TIPOS — tipos de mensagem e de evento da camada de Mensageria.
 *
 * Centraliza as strings para nenhum producer/consumidor escrever tipo
 * "soltado". Cada evento tem **schema zod** (sem PII) para que a publicação
 * seja validada antes de entrar na fila.
 */
import { z } from "zod";

/** Tipos de mensagem (ponto a ponto: uma fila por tipo). */
export const TIPOS_MENSAGEM = ["cliente.enviar", "monitor.encaminhar", "monitor.add-grupo"] as const;
export type TipoMensagem = (typeof TIPOS_MENSAGEM)[number];

/** Tipos de evento (publicação/assinatura: fan-out). */
export const TIPOS_EVENTO = [
  "oferta.recebida",
  "disparo.criado",
  "disparo.concluido",
  "disparo.mensagem.enviada",
  "instancia.conectada",
  "instancia.desconectada",
  "mensagem.dlq",
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

/** Schemas zod dos payloads de evento (sem PII: só ids, contagens e status). */
export const SCHEMAS_EVENTO: Record<TipoEvento, z.ZodTypeAny> = {
  "oferta.recebida": z.object({
    origem: z.string().min(1),
    programa: z.string().min(1),
    idProduto: z.string().nullable(),
    link: z.string().nullable(),
  }),
  "disparo.criado": z.object({
    disparoId: z.string().min(1),
    total: z.number().int().min(0),
  }),
  "disparo.concluido": z.object({
    disparoId: z.string().min(1),
    enviados: z.number().int().min(0),
    falhas: z.number().int().min(0),
  }),
  "disparo.mensagem.enviada": z.object({
    disparoId: z.string().nullable(),
    jid: z.string().min(1),
    ok: z.boolean(),
  }),
  "instancia.conectada": z.object({
    instancia: z.string().min(1),
    motivo: z.string().nullable(),
  }),
  "instancia.desconectada": z.object({
    instancia: z.string().min(1),
    motivo: z.string().nullable(),
  }),
  "mensagem.dlq": z.object({
    tipo: z.string().min(1),
    id: z.string().min(1),
    motivo: z.string().min(1),
    tentativas: z.number().int().min(0),
  }),
};

/** Schema do tipo informado (mensagem ou evento) — undefined se desconhecido. */
export function schemaDoTipo(tipo: string): z.ZodTypeAny | undefined {
  const t = String(tipo ?? "");
  if ((TIPOS_EVENTO as readonly string[]).includes(t)) {
    return SCHEMAS_EVENTO[t as TipoEvento];
  }
  return undefined;
}

/** Valida o payload de um tipo. Retorna `ok:false` com o erro em pt-BR. */
export function validarPayload(
  tipo: string,
  payload: unknown,
): { ok: boolean; data?: unknown; erro?: string } {
  const schema = schemaDoTipo(tipo);
  if (!schema) return { ok: true, data: payload };
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  const campos = parsed.error.issues.map((i) => i.path.join(".") || "(raiz)").join(", ");
  return { ok: false, erro: `payload inválido para ${tipo}: ${campos}` };
}

export function ehTipoMensagem(tipo: string): boolean {
  return (TIPOS_MENSAGEM as readonly string[]).includes(String(tipo ?? ""));
}

export function ehTipoEvento(tipo: string): boolean {
  return (TIPOS_EVENTO as readonly string[]).includes(String(tipo ?? ""));
}
