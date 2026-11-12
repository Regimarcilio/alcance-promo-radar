/**
 * FILA DE CLIENTES — fila de campanhas sobre a camada de Mensageria.
 *
 * A fila de campanhas (aba Clientes) é uma fila de verdade: cada item é um
 * **envelope** `cliente.enviar` guardado no broker. O estado da fila
 * (contadores, pausa, último envio) fica em `data/clientes-estado.json`.
 *
 * Semântica (issue #49):
 * - o item **fica na fila** enquanto é processado (reserva com `reservadoEm`);
 * - **ACK** (sucesso) → sai da fila;
 * - **NACK** (falha) → volta com `tentativas + 1`, `ultimoErro` e
 *   `proximaTentativaEm` (backoff) ou vai para a **DLQ**;
 * - crash → reserva antiga (> 5 min) libera o item de volta para a fila.
 *
 * O store legado `data/clientes-fila.json` é lido **uma vez** (migração
 * idempotente) e passa a ser apenas o registro do estado antigo — os itens
 * vivem no broker.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";
import { criarEnvelope, type Envelope } from "../messaging/envelope.js";
import { getBroker, migrarLegado } from "../messaging/broker.js";
import type { MidiaDisparo } from "./disparos.js";

/** Tipo da fila de campanhas. */
export const TIPO_CLIENTE = "cliente.enviar";

/** Item da campanha (payload do envelope `cliente.enviar`). */
export interface ItemCampanhaMensagem {
  id: string;
  jid: string;
  nome: string;
  texto: string;
  imagem: string;
  disparoId?: string | null;
  midia?: MidiaDisparo | null;
  instancia?: string | null;
  criadoEm: string;
}

export type EnvelopeCliente = Envelope<ItemCampanhaMensagem>;

/** Estado da fila (contadores/pausa) — os ITENS vivem no broker. */
export interface EstadoFila {
  ultimoEnvio: string | null;
  enviados: number;
  erros: number;
  pausado: boolean;
}

/** Reserva abandonada (crash) volta para a fila depois deste tempo. */
export function reservaMaximaMs(): number {
  const n = Number(process.env.MENSAGERIA_RESERVA_MAX_MS ?? 5 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

function arquivoEstado(): string {
  return join(dataDirAtual(), "clientes-estado.json");
}

function arquivoLegado(): string {
  return join(dataDirAtual(), "clientes-fila.json");
}

function arquivoMarcador(): string {
  return join(dataDirAtual(), "messaging", "migracao-cliente.enviar.json");
}

function estadoVazio(): EstadoFila {
  return { ultimoEnvio: null, enviados: 0, erros: 0, pausado: false };
}

/** Estado atual da fila. */
export function estado(): EstadoFila {
  const raw = lerJson<any>(arquivoEstado(), null);
  if (!raw || typeof raw !== "object") {
    // primeira vez: herda o estado do store legado (sem perder histórico)
    const legado = lerJson<any>(arquivoLegado(), null);
    if (legado && typeof legado === "object") {
      const herdado: EstadoFila = {
        ultimoEnvio: legado.ultimoEnvio ?? null,
        enviados: Number(legado.enviados ?? 0),
        erros: Number(legado.erros ?? 0),
        pausado: Boolean(legado.pausado),
      };
      salvarEstado(herdado);
      return herdado;
    }
    return estadoVazio();
  }
  return {
    ultimoEnvio: raw.ultimoEnvio ?? null,
    enviados: Number(raw.enviados ?? 0),
    erros: Number(raw.erros ?? 0),
    pausado: Boolean(raw.pausado),
  };
}

/** Grava o estado da fila (atômico). */
export function salvarEstado(e: EstadoFila): void {
  gravarJsonAtomico(arquivoEstado(), e);
}

/** Atualiza (e grava) o estado da fila. */
export function atualizarEstado(patch: Partial<EstadoFila>): EstadoFila {
  const atual = { ...estado(), ...patch };
  salvarEstado(atual);
  return atual;
}

// ---------- broker ----------

/** Capacidades de broker exigidas pela fila de clientes. */
function brokerCapaz() {
  const b = getBroker();
  const pendentes = b.pendentes?.bind(b);
  const atualizar = b.atualizar?.bind(b);
  const remover = b.remover?.bind(b);
  const limpar = b.limpar?.bind(b);
  if (!pendentes || !atualizar || !remover || !limpar) {
    throw new Error(
      "broker registrado não suporta a fila de clientes (pendentes/atualizar/remover/limpar)"
    );
  }
  return { broker: b, pendentes, atualizar, remover, limpar };
}

/** Envelopes pendentes da fila de clientes (ordem de publicação). */
export function pendentes(): EnvelopeCliente[] {
  const { pendentes: ler } = brokerCapaz();
  return ler(TIPO_CLIENTE) as EnvelopeCliente[];
}

/** Quantidade de itens pendentes. */
export function totalPendentes(): number {
  return pendentes().length;
}

/**
 * Publica itens na fila (cada item = 1 envelope `cliente.enviar`).
 * Devolve o total de pendentes.
 */
export async function enfileirar(itens: ItemCampanhaMensagem[]): Promise<number> {
  const { broker } = brokerCapaz();
  for (const item of itens) {
    const env = criarEnvelope(TIPO_CLIENTE, item, { id: item.id, timestamp: item.criadoEm });
    await broker.publish(env);
  }
  return totalPendentes();
}

/** O envelope está pronto para ser processado? (não reservado, sem backoff) */
export function elegivel(env: EnvelopeCliente, agora = Date.now()): boolean {
  if (env.emAndamento) {
    const desde = Date.parse(env.reservadoEm ?? env.timestamp);
    // reserva antiga = crash: o item volta para a fila
    if (Number.isFinite(desde) && agora - desde < reservaMaximaMs()) return false;
  }
  if (env.proximaTentativaEm) {
    const quando = Date.parse(env.proximaTentativaEm);
    if (Number.isFinite(quando) && quando > agora) return false; // aguardando backoff
  }
  return true;
}

/**
 * Reserva o próximo item elegível (marca `emAndamento`/`reservadoEm`) **sem
 * tirar ele da fila** — é isso que impede a perda de mensagem.
 */
export async function reservarProximo(): Promise<EnvelopeCliente | null> {
  const { pendentes: ler, atualizar } = brokerCapaz();
  const agora = Date.now();
  for (const env of ler(TIPO_CLIENTE) as EnvelopeCliente[]) {
    if (!elegivel(env, agora)) continue;
    const reservado: EnvelopeCliente = {
      ...env,
      emAndamento: true,
      reservadoEm: new Date(agora).toISOString(),
    };
    await atualizar(env.id, reservado);
    return reservado;
  }
  return null;
}

/** ACK: o item foi processado com sucesso → sai da fila. */
export async function confirmar(env: EnvelopeCliente): Promise<void> {
  const { broker } = brokerCapaz();
  await broker.ack(env.id);
  const s = estado();
  salvarEstado({ ...s, enviados: s.enviados + 1 });
}

/**
 * NACK: a mensagem volta para a fila (retry com backoff) ou vai para a DLQ —
 * decisão da política de retry. **Nunca** some com a mensagem.
 */
export async function falhar(env: EnvelopeCliente, erro: string): Promise<void> {
  const { broker } = brokerCapaz();
  await broker.nack(env.id, erro);
  const s = estado();
  salvarEstado({ ...s, erros: s.erros + 1 });
}

/**
 * Recuperação de crash: libera as reservas antigas (o item volta para a fila).
 * Devolve quantos itens foram liberados.
 */
export async function liberarReservasAntigas(): Promise<number> {
  const { pendentes: ler, atualizar } = brokerCapaz();
  const agora = Date.now();
  let liberados = 0;
  for (const env of ler(TIPO_CLIENTE) as EnvelopeCliente[]) {
    if (!env.emAndamento) continue;
    const desde = Date.parse(env.reservadoEm ?? env.timestamp);
    if (Number.isFinite(desde) && agora - desde < reservaMaximaMs()) continue;
    const livre: EnvelopeCliente = { ...env };
    delete livre.emAndamento;
    delete livre.reservadoEm;
    await atualizar(env.id, livre);
    liberados += 1;
  }
  return liberados;
}

/** Remove da fila os itens de um disparo (excluir/cancelar). */
export async function removerPorDisparo(disparoId: string): Promise<number> {
  const { pendentes: ler, remover } = brokerCapaz();
  let n = 0;
  for (const env of ler(TIPO_CLIENTE) as EnvelopeCliente[]) {
    if (env.payload?.disparoId !== disparoId) continue;
    await remover(env.id);
    n += 1;
  }
  return n;
}

/** Atualiza texto/link/mídia/instância dos itens pendentes de um disparo. */
export async function atualizarPorDisparo(
  disparoId: string,
  patch: { texto: string; midia?: MidiaDisparo | null; instancia?: string | null },
): Promise<number> {
  const { pendentes: ler, atualizar } = brokerCapaz();
  let n = 0;
  for (const env of ler(TIPO_CLIENTE) as EnvelopeCliente[]) {
    if (env.payload?.disparoId !== disparoId) continue;
    const payload: ItemCampanhaMensagem = { ...env.payload };
    payload.texto = patch.texto;
    if (patch.midia !== undefined) {
      payload.midia = patch.midia;
      payload.imagem = patch.midia?.arquivo ?? "";
    }
    if (patch.instancia !== undefined) {
      payload.instancia = String(patch.instancia ?? "").trim() || null;
    }
    await atualizar(env.id, { ...env, payload });
    n += 1;
  }
  return n;
}

/** Limpa a fila (usuário cancelou tudo). */
export async function limpar(): Promise<number> {
  const { limpar: limparFila } = brokerCapaz();
  return limparFila(TIPO_CLIENTE);
}

// ---------- migração do store legado ----------

/** Ids já migrados (evita reimportar item que já foi processado). */
function idsMigrados(): Set<string> {
  const raw = lerJson<any>(arquivoMarcador(), { ids: [] });
  const ids = Array.isArray(raw?.ids) ? raw.ids.map(String) : [];
  return new Set(ids);
}

/** Grava o marcador de ids migrados. */
function salvarIdsMigrados(ids: string[]): void {
  gravarJsonAtomico(arquivoMarcador(), { ids, em: new Date().toISOString() });
}

/**
 * Migra o store legado (`data/clientes-fila.json`) para a fila do broker.
 *
 * - **idempotente**: item já migrado (marcador) ou já na fila não é reimportado;
 * - **sem perda**: o legado só é esvaziado DEPOIS da gravação bem-sucedida;
 * - o arquivo legado **não é apagado** (continua como registro do estado
 *   antigo e como fonte de recuperação manual).
 */
export async function migrarLegadoSeNecessario(): Promise<number> {
  const legado = arquivoLegado();
  if (!existsSync(legado)) return 0;
  const raw = lerJson<any>(legado, null);
  const itens: any[] = Array.isArray(raw?.itens) ? raw.itens : [];
  if (!itens.length) return 0;
  const marcados = idsMigrados();
  const novos = itens.filter((i) => i?.id && !marcados.has(String(i.id)));
  if (!novos.length) return 0;
  const n = migrarLegado(getBroker(), {
    tipo: TIPO_CLIENTE,
    arquivo: legado,
    jaMigrados: marcados,
    mapear: (item: any) =>
      criarEnvelope(TIPO_CLIENTE, item as ItemCampanhaMensagem, {
        id: String(item.id),
        timestamp: item.criadoEm ?? new Date().toISOString(),
      }),
  });
  // grava o marcador antes de esvaziar o legado (ordem segura contra crash)
  salvarIdsMigrados([...marcados, ...novos.map((i) => String(i.id))]);
  // esvazia o legado (o arquivo continua existindo)
  gravarJsonAtomico(legado, { ...raw, itens: [] });
  return n;
}
