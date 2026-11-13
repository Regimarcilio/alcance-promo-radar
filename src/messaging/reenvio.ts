/**
 * REENVIO DE DUPLICATAS — reagenda a mensagem duplicata para 24h depois do
 * **lançamento original** (issue #78).
 *
 * Antes: a idempotência **descartava** a duplicata (ACK sem reenviar). Agora o
 * consumidor **reagenda** o envelope para `lançamento + N horas` e ele volta
 * para a fila — passando de novo por todo o ritual da Mensageria (intervalo
 * anti-rajada, janela comercial, ACK/retry/DLQ). **Nunca** há envio avulso.
 *
 * Decisões do operador (12/11/2026):
 * 1. as horas contam a partir do **lançamento original** (o `timestamp` do
 *    envelope / `criadoEm` do item), não da detecção da duplicata;
 * 2. vale para **todos os fluxos** (Clientes/Disparo e Monitor) — e é
 *    **configurável por tipo**, para desligar sem mexer em código;
 * 3. o reenvio é **único**: se o reenvio falhar, segue o retry/DLQ normal
 *    (nunca reagenda +24h de novo).
 *
 * REGRA DO "PRÓXIMO MOMENTO VÁLIDO" (documentada aqui porque é a regra que
 * evita `proximaTentativaEm` no passado):
 *
 *   alvo = lançamento + N horas
 *   enquanto (alvo <= agora) alvo = alvo + N horas
 *
 * Com o padrão de 24h isso significa: mensagem lançada ontem às 08:00 e
 * detectada hoje às 10:00 é reagendada para **as 08:00 de amanhã** (o mesmo
 * horário do lançamento, no próximo ciclo) — nunca para um instante passado.
 * A fila continua respeitando a janela comercial e o intervalo anti-rajada:
 * o reagendamento só define **quando** a mensagem fica elegível.
 */
import type { Envelope, MarcadorReenvio } from "./envelope.js";

/** O marcador do reenvio vive no envelope (fonte única do formato). */
export type { MarcadorReenvio };

/** Opções do agendamento (injetáveis para teste determinístico). */
export interface OpcoesReenvio {
  /** horas entre o lançamento e o reenvio (default: `MENSAGERIA_REENVIO_DUP_HORAS`) */
  horas?: number;
  /** instante de referência (ms) — default: agora */
  agora?: number;
}

/** Horas padrão do reenvio (o pedido do operador: 24h). */
export const HORAS_REENVIO_PADRAO = 24;

/** Tipos com reenvio habilitado por padrão (todos os fluxos). */
export const TIPOS_REENVIO_PADRAO = ["cliente.enviar", "monitor.encaminhar"];

/** O reenvio de duplicatas está ligado? (`MENSAGERIA_REENVIO_DUP_ATIVO`, default 1) */
export function reenvioAtivo(): boolean {
  const v = String(process.env.MENSAGERIA_REENVIO_DUP_ATIVO ?? "1").trim().toLowerCase();
  if (!v) return true;
  return !["0", "false", "nao", "não", "off", "desligado"].includes(v);
}

/** Horas entre o lançamento e o reenvio (`MENSAGERIA_REENVIO_DUP_HORAS`, default 24). */
export function horasReenvio(): number {
  const n = Number(process.env.MENSAGERIA_REENVIO_DUP_HORAS ?? HORAS_REENVIO_PADRAO);
  return Number.isFinite(n) && n > 0 ? n : HORAS_REENVIO_PADRAO;
}

/** Tipos com reenvio habilitado (`MENSAGERIA_REENVIO_DUP_TIPOS`; `*` = todos). */
export function tiposComReenvio(): string[] {
  const bruto = process.env.MENSAGERIA_REENVIO_DUP_TIPOS;
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") {
    return [...TIPOS_REENVIO_PADRAO];
  }
  return String(bruto)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * O reenvio é permitido para este tipo de mensagem?
 *
 * Depende do switch global (`MENSAGERIA_REENVIO_DUP_ATIVO`) e do switch por
 * tipo (`MENSAGERIA_REENVIO_DUP_TIPOS`). Com o global desligado, **nenhum**
 * tipo é permitido (volta ao descarte da duplicata).
 */
export function reenvioPermitido(tipo: string): boolean {
  if (!reenvioAtivo()) return false;
  const tipos = tiposComReenvio();
  if (!tipos.length) return false;
  if (tipos.includes("*")) return true;
  return tipos.includes(String(tipo ?? "").trim());
}

/**
 * O envelope/item já é um **reenvio agendado**?
 *
 * Serve para o consumidor **pular a checagem de idempotência** no reenvio —
 * sem isso, o reenvio se detectaria como duplicata e se reagendaria em loop.
 */
export function ehReenvioAgendado(
  env: { reenvio?: MarcadorReenvio | null } | null | undefined,
): boolean {
  return Boolean(env?.reenvio?.originalEm);
}

/**
 * Instante do reenvio: lançamento original + N horas, rolado para o próximo
 * ciclo enquanto ficar no passado (nunca no passado).
 */
export function momentoReenvio(
  originalEm: string,
  opts: OpcoesReenvio = {},
): { em: string; horas: number; ciclos: number } {
  const horas = opts.horas ?? horasReenvio();
  const agoraMs = opts.agora ?? Date.now();
  const originalMs = Date.parse(originalEm);
  const base = Number.isFinite(originalMs) ? originalMs : agoraMs;
  const passo = horas * 3_600_000;
  let alvo = base + passo;
  let ciclos = 0;
  // rolagem: o reenvio cai sempre no próximo ciclo (mesmo horário do lançamento)
  while (alvo <= agoraMs && ciclos < 3660) {
    alvo += passo;
    ciclos += 1;
  }
  return {
    em: new Date(alvo).toISOString(),
    horas: Math.max(0, (alvo - agoraMs) / 3_600_000),
    ciclos,
  };
}

/**
 * Devolve o envelope **reagendado** para o reenvio.
 *
 * - `proximaTentativaEm` = lançamento + N horas (nunca no passado);
 * - marca o envelope com `reenvio: { originalEm, agendadoEm, chave }`;
 * - **preserva** `correlationId` (rastreio do fluxo original) e a `chave`;
 * - limpa a reserva (`emAndamento`/`reservadoEm`): o item volta para a fila.
 *
 * O envelope **não** é confirmado (ACK): ele continua na fila.
 */
export function agendarReenvioDuplicado<T>(
  env: Envelope<T>,
  opts: OpcoesReenvio = {},
): Envelope<T> {
  const agoraMs = opts.agora ?? Date.now();
  const momento = momentoReenvio(env.timestamp, { ...opts, agora: agoraMs });
  const novo: Envelope<T> = {
    ...env,
    proximaTentativaEm: momento.em,
    reenvio: {
      originalEm: env.timestamp,
      agendadoEm: new Date(agoraMs).toISOString(),
      chave: env.chave ?? "",
    },
  };
  delete novo.emAndamento;
  delete novo.reservadoEm;
  return novo;
}

/**
 * Monta o marcador de reenvio de um item que **não** é envelope (fila do
 * Monitor, que tem store próprio). Mesma forma do marcador do envelope.
 */
export function marcadorReenvio(
  originalEm: string,
  chave: string,
  opts: OpcoesReenvio = {},
): MarcadorReenvio {
  const agoraMs = opts.agora ?? Date.now();
  return {
    originalEm,
    agendadoEm: new Date(agoraMs).toISOString(),
    chave,
  };
}
