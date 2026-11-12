/**
 * BROKER — abstração (port) + adapter de arquivo (FileBroker).
 *
 * A camada de Mensageria fala com uma **port** (`Broker`), nunca com um
 * transporte concreto. O adapter inicial é o **FileBroker** (fila em JSON,
 * escrita atômica com 0600). Trocar por RabbitMQ/Kafka depois é registrar
 * outro adapter — sem tocar em produtores nem consumidores.
 *
 * Semântica implementada aqui:
 * - `publish` empilha; `ack` remove (sucesso); `nack` devolve à fila com
 *   `tentativas + 1` (falha). A política de retry/DLQ entra pela gancho
 *   `politicaNack` (issue #49) — o default é apenas devolver à fila.
 * - A mensagem **só sai da fila no ACK** — falha não perde nada.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gravarJsonAtomico, lerJson } from "../store/json.js";
import { caminhoFila, caminhoStats, dirMensageria, nomeSeguro } from "./caminhos.js";
import { gravarDlq, lerDlq, registrarDlq, removerDlq } from "./dlq.js";
import { politicaPadrao } from "./politica.js";
import type { Envelope } from "./envelope.js";

export type { ItemDLQ } from "./dlq.js";
import type { ItemDLQ } from "./dlq.js";

export interface QueueStats {
  pendentes: number;
  processadas: number;
  falhas: number;
  dlq: number;
  /** ISO do envelope pendente mais antigo (null se a fila está vazia) */
  maisAntigaEm: string | null;
}

export interface Broker {
  publish<T>(env: Envelope<T>): Promise<void>;
  consume<T>(tipo: string, handler: (env: Envelope<T>) => Promise<void>): void;
  ack(id: string): Promise<void>;
  nack(id: string, erro: string): Promise<void>;
  tamanho(tipo: string): number;
  dlq(tipo: string): ItemDLQ[];
  reprocessar(id: string): Promise<void>;
  stats(tipo: string): QueueStats;
  /**
   * Envelopes pendentes de um tipo (extensão opcional do port — usada pela
   * migração do legado, pelos consumidores e pela inspeção de diagnóstico).
   */
  pendentes?(tipo: string): Envelope[];
  /** substitui o envelope pelo id (atualizar estado sem ACK) */
  atualizar?(id: string, env: Envelope): Promise<void>;
  /** remove o envelope da fila sem contar como processado (cancelamento) */
  remover?(id: string): Promise<void>;
  /** limpa a fila do tipo e devolve quantos itens foram removidos */
  limpar?(tipo: string): Promise<number>;
}

/** Contexto entregue à política de `nack` (issue #49 pluga retry/DLQ aqui). */
export interface ContextoNack {
  tipo: string;
  envelope: Envelope;
  erro: string;
  /** nº de tentativas já contabilizadas (após o incremento) */
  tentativas: number;
  /** devolve o envelope ao fim da fila */
  reenfileirar: (env: Envelope) => Promise<void>;
  /** manda o envelope para a DLQ com o motivo */
  paraDlq: (item: ItemDLQ) => Promise<void>;
}

export type PoliticaNack = (ctx: ContextoNack) => Promise<void>;

export interface OpcoesFileBroker {
  /** política de falha (retry/DLQ). Default: devolve à fila. */
  politicaNack?: PoliticaNack;
  /** diretório base das filas (default: <data>/messaging) */
  dir?: string;
}

interface Contadores {
  publicadas: number;
  processadas: number;
  falhas: number;
}

export class FileBroker implements Broker {
  private readonly dir: string;
  private readonly politicaNack: PoliticaNack;

  constructor(op: OpcoesFileBroker = {}) {
    this.dir = op.dir ?? dirMensageria();
    // Default: retry com backoff (erro transitório) ou DLQ (permanente/
    // tentativas esgotadas) — a política padrão da camada de Mensageria.
    this.politicaNack = op.politicaNack ?? politicaPadrao();
  }

  /** Diretório base das filas (usado para validar o broker global). */
  get diretorio(): string {
    return this.dir;
  }

  // ---------- caminhos ----------
  private arquivoFila(tipo: string): string {
    return join(this.dir, `${nomeSeguro(tipo)}.json`);
  }
  private arquivoStats(tipo: string): string {
    return join(this.dir, `stats-${nomeSeguro(tipo)}.json`);
  }

  // ---------- leitura/escrita ----------
  private lerFila(tipo: string): Envelope[] {
    const raw = lerJson<any>(this.arquivoFila(tipo), []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && typeof e.id === "string" && typeof e.tipo === "string") as Envelope[];
  }

  private salvarFila(tipo: string, itens: Envelope[]): void {
    gravarJsonAtomico(this.arquivoFila(tipo), itens);
  }

  private lerStats(tipo: string): Contadores {
    const raw = lerJson<any>(this.arquivoStats(tipo), {});
    return {
      publicadas: Number(raw?.publicadas ?? 0),
      processadas: Number(raw?.processadas ?? 0),
      falhas: Number(raw?.falhas ?? 0),
    };
  }

  private salvarStats(tipo: string, c: Contadores): void {
    gravarJsonAtomico(this.arquivoStats(tipo), c);
  }

  /** Tipos de fila existentes no diretório (sem dlq-/stats-). */
  private tiposExistentes(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .filter((f) => !f.startsWith("dlq-") && !f.startsWith("stats-"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  /** Localiza o envelope pelo id em qualquer fila. */
  private localizar(id: string): { tipo: string; envelope: Envelope } | null {
    for (const tipo of this.tiposExistentes()) {
      const itens = this.lerFila(tipo);
      const env = itens.find((e) => e.id === id);
      if (env) return { tipo, envelope: env };
    }
    return null;
  }

  // ---------- port ----------
  async publish<T>(env: Envelope<T>): Promise<void> {
    const tipo = env.tipo;
    const itens = this.lerFila(tipo);
    itens.push(env as Envelope);
    this.salvarFila(tipo, itens);
    const c = this.lerStats(tipo);
    c.publicadas += 1;
    this.salvarStats(tipo, c);
  }

  /**
   * Processa as mensagens pendentes uma a uma: sucesso → `ack`, erro →
   * `nack` (nunca descarte). A política de retry/DLQ entra no `nack`.
   */
  consume<T>(tipo: string, handler: (env: Envelope<T>) => Promise<void>): void {
    void (async () => {
      const itens = this.lerFila(tipo);
      for (const env of itens) {
        try {
          await handler(env as Envelope<T>);
          await this.ack(env.id);
        } catch (e: any) {
          await this.nack(env.id, String(e?.message ?? e));
        }
      }
    })();
  }

  async ack(id: string): Promise<void> {
    const achado = this.localizar(id);
    if (!achado) return;
    const itens = this.lerFila(achado.tipo).filter((e) => e.id !== id);
    this.salvarFila(achado.tipo, itens);
    const c = this.lerStats(achado.tipo);
    c.processadas += 1;
    this.salvarStats(achado.tipo, c);
  }

  async nack(id: string, erro: string): Promise<void> {
    const achado = this.localizar(id);
    if (!achado) return;
    const itens = this.lerFila(achado.tipo);
    const atual = itens.find((e) => e.id === id);
    if (!atual) return;
    const actualizado: Envelope = {
      ...atual,
      tentativas: Number(atual.tentativas ?? 0) + 1,
      ultimoErro: erro,
    };
    const c = this.lerStats(achado.tipo);
    c.falhas += 1;
    this.salvarStats(achado.tipo, c);
    // A mensagem sai da fila no nack: a política decide o destino
    // (devolver à fila = retry; DLQ = esgotou). Nunca se perde.
    this.salvarFila(
      achado.tipo,
      itens.filter((e) => e.id !== id)
    );
    await this.politicaNack({
      tipo: achado.tipo,
      envelope: actualizado,
      erro,
      tentativas: actualizado.tentativas,
      reenfileirar: async (env) => {
        const atuais = this.lerFila(achado.tipo).filter((e) => e.id !== env.id);
        this.salvarFila(achado.tipo, [...atuais, env]);
      },
      paraDlq: async (item) => {
        registrarDlq(item);
      },
    });
  }

  tamanho(tipo: string): number {
    return this.lerFila(tipo).length;
  }

  dlq(tipo: string): ItemDLQ[] {
    return lerDlq(tipo);
  }

  /**
   * Reprocessa um item da DLQ: ele volta para a fila de origem.
   *
   * O item **não perde o histórico**: `tentativas` zera (o consumidor conta
   * do zero), mas o `ultimoErro` é **preservado** (auditoria: por que a
   * mensagem morreu) e o `reprocessos` é **incrementado** (quantas vezes o
   * operador reparou essa mensagem). Backoff e reserva são limpos para que o
   * item volte a ser elegível no próximo ciclo da fila.
   */
  async reprocessar(id: string): Promise<void> {
    const item = removerDlq(id);
    if (!item) return;
    const env: Envelope = {
      ...item.envelope,
      tentativas: 0,
      reprocessos: Number(item.envelope.reprocessos ?? 0) + 1,
    };
    delete env.proximaTentativaEm;
    delete env.emAndamento;
    delete env.reservadoEm;
    const itens = this.lerFila(env.tipo).filter((e) => e.id !== env.id);
    this.salvarFila(env.tipo, [...itens, env]);
  }

  stats(tipo: string): QueueStats {
    const pendentes = this.lerFila(tipo);
    const c = this.lerStats(tipo);
    const maisAntiga = pendentes.reduce<string | null>(
      (min, e) => (!min || e.timestamp < min ? e.timestamp : min),
      null
    );
    return {
      pendentes: pendentes.length,
      processadas: c.processadas,
      falhas: c.falhas,
      dlq: this.dlq(tipo).length,
      maisAntigaEm: maisAntiga,
    };
  }

  /** Envelopes pendentes de um tipo (extensão opcional do port). */
  pendentes(tipo: string): Envelope[] {
    return this.lerFila(tipo);
  }

  /** Substitui o envelope pelo id (estado novo, sem ACK). */
  async atualizar(id: string, env: Envelope): Promise<void> {
    const achado = this.localizar(id);
    if (!achado) return;
    const itens = this.lerFila(achado.tipo);
    const i = itens.findIndex((e) => e.id === id);
    if (i < 0) return;
    itens[i] = env;
    this.salvarFila(achado.tipo, itens);
  }

  /** Remove o envelope da fila sem contar como processado. */
  async remover(id: string): Promise<void> {
    const achado = this.localizar(id);
    if (!achado) return;
    this.salvarFila(
      achado.tipo,
      this.lerFila(achado.tipo).filter((e) => e.id !== id)
    );
  }

  /** Limpa a fila do tipo (devolve quantos itens saíram). */
  async limpar(tipo: string): Promise<number> {
    const itens = this.lerFila(tipo);
    this.salvarFila(tipo, []);
    return itens.length;
  }

  /** Grava direto na DLQ (usado por filas que não usam o broker, como a do Monitor). */
  async deadLetter(item: ItemDLQ): Promise<void> {
    gravarDlq(item.tipo, [...lerDlq(item.tipo), item]);
  }
}

// ---------- registro global do broker ----------

let brokerAtual: Broker | null = null;

/** Registra o adapter global (permite trocar FileBroker por AMQP no futuro). */
export function setBroker(broker: Broker): void {
  brokerAtual = broker;
}

/**
 * Broker global — cria um FileBroker padrão na primeira chamada.
 * Se o `ALCANCE_DATA_DIR` mudar (teste/smoke), o FileBroker é recriado para
 * não escrever no diretório do teste anterior.
 */
export function getBroker(): Broker {
  if (brokerAtual instanceof FileBroker && brokerAtual.diretorio !== dirMensageria()) {
    brokerAtual = null;
  }
  if (!brokerAtual) brokerAtual = new FileBroker();
  return brokerAtual;
}

/** Limpa o broker global (usado em teste). */
export function resetBroker(): void {
  brokerAtual = null;
}

// ---------- migração do legado ----------

export interface OpcaoMigracao {
  /** tipo da fila de destino ("cliente.enviar") */
  tipo: string;
  /** caminho do arquivo legado (ex.: data/clientes-fila.json) */
  arquivo: string;
  /** converte um item legado em envelope */
  mapear: (item: any) => Envelope;
  /** ids já migrados antes (evita reimportar item já processado) */
  jaMigrados?: Set<string>;
}

/**
 * Converte itens legados (sem envelope) em envelopes na fila do broker.
 *
 * - **Idempotente**: item cujo id de envelope já está na fila (ou no conjunto
 *   `jaMigrados`) NÃO é republicado — o `mapear` deve usar o id legado como id
 *   do envelope para garantir isso.
 * - **Não apaga o arquivo legado**: até a fila de Clientes consumir do broker
 *   o store legado ainda é lido; apagar aqui perderia a fila viva. Quem migra
 *   esvazia o store legado **após** a gravação bem-sucedida.
 *
 * Devolve quantos itens foram migrados.
 */
export function migrarLegado(broker: Broker, op: OpcaoMigracao): number {
  if (!existsSync(op.arquivo)) return 0;
  const raw = lerJson<any>(op.arquivo, null);
  if (!raw) return 0;
  const itens: any[] = Array.isArray(raw) ? raw : Array.isArray(raw.itens) ? raw.itens : [];
  if (!itens.length) return 0;
  const jaExistentes = new Set((broker.pendentes?.(op.tipo) ?? []).map((e) => e.id));
  for (const id of op.jaMigrados ?? []) jaExistentes.add(id);
  let migrados = 0;
  for (const item of itens) {
    const env = op.mapear(item);
    if (!env || jaExistentes.has(env.id)) continue;
    jaExistentes.add(env.id);
    broker.publish(env);
    migrados += 1;
  }
  return migrados;
}
