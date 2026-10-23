/**
 * Estado do monitor (E6 / RF-035 / RN-010).
 * - Dedup configurável (padrão 7 dias) por hash `programa+idProduto+linkTransformado`.
 * - Contadores vitalícios separados do buffer de eventos (não saturam em 500).
 * Persistência em data/monitor-estado.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico } from "../store/json.js";

const file = join(dataDirAtual(), "monitor-estado.json");

export const DEDUP_DIAS = 7;

/**
 * Janela do dedup (dias). 7 = padrão; menor = repassa o mesmo produto mais
 * rápido (mais volume no destino, mais risco de repetição).
 */
export function diasDedup(): number {
  const v = Number(process.env.DEDUP_DIAS ?? DEDUP_DIAS);
  return Number.isFinite(v) && v > 0 ? v : DEDUP_DIAS;
}

/**
 * Dedup por origem: quando ligado, o mesmo produto vindo de ORIGENS
 * diferentes é reencaminhado (cada grupo publica 1 vez). Desligado (padrão),
 * o produto é bloqueado no ALCANCE inteiro por 7 dias.
 */
export function dedupPorOrigem(): boolean {
  return process.env.DEDUP_POR_ORIGEM === "1";
}
export const LIMITE_EVENTOS = Number(process.env.MONITOR_EVENTOS_LIMITE ?? 500); // 0 = ilimitado

export interface EventoMonitor {
  em: string;
  origem: string;
  programa: string;
  idProduto: string | null;
  linkTransformado: string | null;
  destino: string | null;
  status: "ENCAMINHADA" | "DUPLICADO" | "REVISAO" | "ERRO" | "ENFILEIRADA";
  messageId?: string;
  detalhe?: string;
}

export interface TotaisMonitor {
  recebidas: number;
  encaminhadas: number;
  duplicadas: number;
  revisao: number;
  erros: number;
  enfileiradas: number;
}

interface Estado {
  hashes: Record<string, string>; // hash → ISO do processamento
  eventos: EventoMonitor[];
  totais: TotaisMonitor;
}

function blank(): Estado {
  return {
    hashes: {},
    eventos: [],
    totais: { recebidas: 0, encaminhadas: 0, duplicadas: 0, revisao: 0, erros: 0, enfileiradas: 0 },
  };
}

function totaisDosEventos(eventos: EventoMonitor[]): TotaisMonitor {
  return {
    recebidas: eventos.length,
    encaminhadas: eventos.filter((e) => e.status === "ENCAMINHADA").length,
    duplicadas: eventos.filter((e) => e.status === "DUPLICADO").length,
    revisao: eventos.filter((e) => e.status === "REVISAO").length,
    erros: eventos.filter((e) => e.status === "ERRO").length,
    enfileiradas: eventos.filter((e) => e.status === "ENFILEIRADA").length,
  };
}

function acrescentarTotal(t: TotaisMonitor, status: EventoMonitor["status"]): void {
  t.recebidas += 1;
  if (status === "ENCAMINHADA") t.encaminhadas += 1;
  else if (status === "DUPLICADO") t.duplicadas += 1;
  else if (status === "REVISAO") t.revisao += 1;
  else if (status === "ERRO") t.erros += 1;
  else if (status === "ENFILEIRADA") t.enfileiradas += 1;
}

// Última leitura boa: evita que um erro transitório de I/O devolva estado vazio
// e a próxima gravação persista o vazio (perda de eventos/dedup).
let cache: Estado | null = null;

function carregar(): Estado {
  try {
    if (!existsSync(file)) return cache ?? blank();
    const s: any = JSON.parse(readFileSync(file, "utf8"));
    const eventos = Array.isArray(s?.eventos) ? s.eventos : [];
    const totais = s?.totais && typeof s.totais === "object" ? s.totais : totaisDosEventos(eventos);
    cache = {
      hashes: s?.hashes && typeof s.hashes === "object" ? s.hashes : {},
      eventos,
      totais: {
        recebidas: Number(totais.recebidas) || 0,
        encaminhadas: Number(totais.encaminhadas) || 0,
        duplicadas: Number(totais.duplicadas) || 0,
        revisao: Number(totais.revisao) || 0,
        erros: Number(totais.erros) || 0,
        enfileiradas: Number(totais.enfileiradas) || 0,
      },
    };
    return cache;
  } catch {
    return cache ?? blank();
  }
}

function podarHashes(hashes: Record<string, string>): number {
  const corte = Date.now() - diasDedup() * 86_400_000;
  let removidos = 0;
  for (const [h, iso] of Object.entries(hashes)) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || t < corte) {
      delete hashes[h];
      removidos += 1;
    }
  }
  return removidos;
}

function salvar(s: Estado): void {
  if (LIMITE_EVENTOS > 0) s.eventos = s.eventos.slice(-LIMITE_EVENTOS);
  podarHashes(s.hashes);
  cache = s;
  gravarJsonAtomico(file, s);
}

export function hashMonitor(programa: string, idProduto: string | null, link: string, origem?: string): string {
  const escopo = dedupPorOrigem() && origem ? `|${origem}` : "";
  const chave = idProduto ? `${programa}${escopo}|${idProduto}` : `${programa}${escopo}|#link|${link}`;
  return createHash("sha1").update(chave).digest("hex").slice(0, 16);
}

/** Já encaminhado nos últimos N dias? (RF-035) */
export function jaMonitorado(programa: string, idProduto: string | null, link: string, origem?: string): boolean {
  const s = carregar();
  const h = hashMonitor(programa, idProduto, link, origem);
  const quando = s.hashes[h];
  if (!quando) return false;
  const limite = Date.now() - diasDedup() * 86400_000;
  return new Date(quando).getTime() >= limite;
}

export function marcarMonitorado(programa: string, idProduto: string | null, link: string, origem?: string): void {
  const s = carregar();
  s.hashes[hashMonitor(programa, idProduto, link, origem)] = new Date().toISOString();
  salvar(s);
}

/**
 * Reserva atômica do dedup: checa e grava na MESMA operação síncrona, antes de
 * qualquer `await`. Duas mensagens concorrentes do mesmo produto só passam uma.
 * Retorna false se o produto já estava reservado/enviado na janela.
 */
export function reservarMonitorado(programa: string, idProduto: string | null, link: string, origem?: string): boolean {
  const s = carregar();
  const h = hashMonitor(programa, idProduto, link, origem);
  const quando = s.hashes[h];
  const limite = Date.now() - diasDedup() * 86400_000;
  if (quando && new Date(quando).getTime() >= limite) return false;
  s.hashes[h] = new Date().toISOString();
  salvar(s);
  return true;
}

/** Devolve a reserva quando o envio não vai acontecer (revisão/falha definitiva). */
export function liberarReserva(programa: string, idProduto: string | null, link: string, origem?: string): void {
  const s = carregar();
  const h = hashMonitor(programa, idProduto, link, origem);
  if (!s.hashes[h]) return;
  delete s.hashes[h];
  salvar(s);
}

export function registrarEvento(ev: EventoMonitor): void {
  const s = carregar();
  s.eventos.push(ev);
  acrescentarTotal(s.totais, ev.status);
  salvar(s);
}

/** Zera os contadores (eventos + totais). Mantém regras e dedup. */
export function zerarContadores(): number {
  const s = carregar();
  const n = s.eventos.length;
  s.eventos = [];
  s.totais = blank().totais;
  salvar(s);
  return n;
}

/** Limpa o histórico de dedup (permite reenviar produtos já enviados). */
export function limparDedup(): number {
  const s = carregar();
  const n = Object.keys(s.hashes).length;
  s.hashes = {};
  salvar(s);
  return n;
}

export function eventos(limite = 100): EventoMonitor[] {
  return carregar().eventos.slice(-limite).reverse();
}

/** Estatísticas resumidas para a interface (vitalícias, não limitadas ao buffer). */
export function resumo(): TotaisMonitor {
  return { ...carregar().totais };
}

/** Apenas para testes/inspeção: quantidade de hashes dentro da janela. */
export function totalHashes(): number {
  return Object.keys(carregar().hashes).length;
}
