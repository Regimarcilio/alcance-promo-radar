/**
 * TÓPICOS (Publicação/Assinatura) — eventos com fan-out e fila por assinante.
 *
 * Semântica da aula de Mensageria:
 * - o produtor publica um evento e **todos os assinantes** recebem — o
 *   produtor **não conhece** os consumidores;
 * - cada assinante tem **fila própria**
 *   (`data/messaging/topico-<tipo>-<assinante>.json`): um assinante que falha
 *   **não afeta** os outros e um assinante que estava fora do ar recebe tudo
 *   o que foi publicado enquanto estava fora (reentrega a partir da sua fila);
 * - **assinantes novos não recebem histórico** (semântica de tópico): a fila do
 *   assinante só passa a existir a partir da primeira publicação feita
 *   enquanto ele estava assinado.
 */
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";
import { criarEnvelope, type Envelope } from "./envelope.js";
import { chaveDe } from "./idempotencia.js";
import { validarPayload, TIPOS_EVENTO } from "./tipos.js";
import { incrementar } from "./contadores.js";
import { consumidorAuditoria, consumidorLog, consumidorMetricas } from "./consumidores.js";

export type HandlerEvento = (env: Envelope) => Promise<void>;

interface Assinante {
  tipo: string;
  nome: string;
  handler: HandlerEvento;
}

/** Assinantes registrados em memória (por processo). */
const assinantes = new Map<string, Assinante>();

function chaveAssinante(tipo: string, nome: string): string {
  return `${tipo}:${nome}`;
}

/** Fila do assinante: data/messaging/topico-<tipo>-<assinante>.json */
export function caminhoFilaAssinante(tipo: string, nome: string): string {
  const seguro = (v: string) => String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "desconhecido";
  return join(dataDirAtual(), "messaging", `topico-${seguro(tipo)}-${seguro(nome)}.json`);
}

function lerFilaAssinante(a: Assinante): Envelope[] {
  const raw = lerJson<any>(caminhoFilaAssinante(a.tipo, a.nome), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e.id === "string") as Envelope[];
}

function gravarFilaAssinante(a: Assinante, itens: Envelope[]): void {
  gravarJsonAtomico(caminhoFilaAssinante(a.tipo, a.nome), itens);
}

/**
 * Publica um evento: valida o payload, cria o envelope e **entrega a todos os
 * assinantes** (cada um com a sua fila). Não lança se um assinante falhar —
 * a falha é isolada na fila dele.
 */
export function publicarEvento<T>(
  tipo: string,
  payload: T,
  opts: { correlationId?: string; chave?: string } = {},
): Envelope<T> {
  // 1. payload validado pelo schema zod do tipo (nada de payload solto)
  const validado = validarPayload(tipo, payload);
  if (!validado.ok) throw new Error(validado.erro ?? `payload inválido para ${tipo}`);

  // 2. envelope no mesmo formato das mensagens
  const env = criarEnvelope<T>(tipo, validado.data as T, {
    correlationId: opts.correlationId,
  });
  // chave do evento: `${tipo}:${id}` (o id do envelope já é único)
  env.chave = opts.chave ?? chaveDe(tipo, { id: env.id });

  // 3. fan-out: cada assinante recebe uma cópia na SUA fila
  for (const a of assinantesDoTipo(tipo)) {
    const itens = lerFilaAssinante(a);
    itens.push(env as Envelope);
    gravarFilaAssinante(a, itens);
  }

  // 4. entrega (assíncrona: o produtor não espera o consumidor)
  for (const a of assinantesDoTipo(tipo)) {
    void processarAssinante(a);
  }

  incrementar("alcance_msg_publicadas_total", { tipo });
  return env;
}

/** Assinantes de um tipo. */
export function assinantesDoTipo(tipo: string): Assinante[] {
  return [...assinantes.values()].filter((a) => a.tipo === tipo);
}

/**
 * Assina um evento. O assinante recebe tudo o que for publicado a partir de
 * agora — **não** recebe histórico.
 */
export function assinarEvento<T>(tipo: string, nome: string, handler: HandlerEvento): void {
  assinantes.set(chaveAssinante(tipo, nome), { tipo, nome, handler: handler as HandlerEvento });
  // assinante que voltou: recebe o que ficou na fila dele
  void processarAssinante({ tipo, nome, handler: handler as HandlerEvento });
}

/** Cancela a assinatura (a fila do assinante é preservada). */
export function desassinarEvento(tipo: string, nome: string): void {
  assinantes.delete(chaveAssinante(tipo, nome));
}

/**
 * Processa a fila do assinante em ordem: sucesso → ACK (sai da fila); erro →
 * o item **fica** na fila dele (reentrega) e os outros assinantes seguem
 * normalmente (falha isolada).
 */
export async function processarAssinante(a: Assinante): Promise<number> {
  const itens = lerFilaAssinante(a);
  let processados = 0;
  for (const env of itens) {
    try {
      await a.handler(env);
      const atuais = lerFilaAssinante(a).filter((e) => e.id !== env.id);
      gravarFilaAssinante(a, atuais);
      processados += 1;
      incrementar("alcance_msg_processadas_total", { tipo: a.tipo, resultado: "ok" });
    } catch (e: any) {
      // falha isolada: o item continua na fila do assinante para reprocessar
      incrementar("alcance_msg_processadas_total", { tipo: a.tipo, resultado: "erro" });
      break;
    }
  }
  return processados;
}

/**
 * Processa as filas pendentes de todos os assinantes (ou de um tipo).
 * Usado no boot (reentrega do que ficou na fila) e nos testes.
 */
export async function processarPendentes(tipo?: string): Promise<number> {
  const alvo = tipo ? assinantesDoTipo(tipo) : [...assinantes.values()];
  let total = 0;
  for (const a of alvo) total += await processarAssinante(a);
  return total;
}

/** Snapshot dos assinantes e do que está pendente em cada fila. */
export function estadoAssinantes(): { tipo: string; nome: string; pendentes: number }[] {
  return [...assinantes.values()].map((a) => ({
    tipo: a.tipo,
    nome: a.nome,
    pendentes: lerFilaAssinante(a).length,
  }));
}

/** Zera os assinantes (usado em teste). */
export function resetarAssinantes(): void {
  assinantes.clear();
}

// ---------- consumidores padrão (fan-out real) ----------
//
// Auditoria, métricas e log acompanham **todos** os eventos. Nenhum deles
// altera o comportamento do produtor — é o teste do desacoplamento.
for (const tipo of TIPOS_EVENTO) {
  assinarEvento(tipo, "auditoria", consumidorAuditoria);
  assinarEvento(tipo, "metricas", consumidorMetricas);
  assinarEvento(tipo, "log", consumidorLog);
}
