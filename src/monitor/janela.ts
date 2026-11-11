/**
 * Janela de envio (quiet hours) — ofertas só saem entre 08:00 e 23:00
 * (hora local do manager, TZ America/Sao_Paulo), com variação diária de até
 * ±10 min nas bordas para o horário não parecer robótico.
 *
 * A variação é determinística por dia (seed = data local) e persistida em
 * data/monitor-janela.json, então o painel e os envios concordam entre
 * restarts do manager.
 *
 * Regras:
 *  - Dentro da janela: envio normal (fila libera 1 a cada intervalo).
 *  - Fora da janela (22:50–23:00, 00:00–08:10): acumula na fila/revisionar;
 *    a fila só libera quando a janela abre (≈08:00 ± 10min).
 *  - Ofertas que chegam fora da janela NÃO são perdidas: ficam na fila e são
 *    liberadas na abertura (uma a cada intervalo).
 */
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";

const file = join(dataDirAtual(), "monitor-janela.json");

/** Hora local (America/Sao_Paulo, sem DST desde 2019) — leitura estável. */
export function horaLocal(d = new Date()): { h: number; m: number; data: string } {
  const p = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const dia = String(g("day")).padStart(2, "0");
  const mes = String(g("month")).padStart(2, "0");
  return { h: g("hour") % 24, m: g("minute"), data: `${g("year")}-${mes}-${dia}` };
}

/** Hash estável (FNV-1a) da data local — base do jitter determinístico. */
function hashDia(data: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Offset do dia em minutos, determinístico em [-10, +10]. */
export function offsetDoDia(data: string): number {
  return (hashDia(data) % 21) - 10;
}

interface StoreJanela {
  /** chave = data local (AAAA-MM-DD); valor = offset em minutos [-10,+10] */
  offsets: Record<string, number>;
}

let cache: StoreJanela | null = null;

function carregar(): StoreJanela {
  if (cache) return cache;
  const raw = lerJson<StoreJanela>(file, { offsets: {} });
  cache = raw && typeof raw === "object" && raw.offsets && typeof raw.offsets === "object"
    ? raw
    : { offsets: {} };
  return cache;
}

function salvar(s: StoreJanela): void {
  cache = s;
  gravarJsonAtomico(file, s);
}

/**
 * Offset do dia (lendo/persistindo): primeiro acesso do dia grava o valor.
 * Pode ser sobrescrito manualmente editando data/monitor-janela.json.
 */
export function offsetDoDiaPersistido(data: string): number {
  const s = carregar();
  const k = data;
  if (typeof s.offsets[k] === "number") return s.offsets[k];
  const v = offsetDoDia(data);
  s.offsets[k] = v;
  // faxina: mantém só os últimos 7 dias para o arquivo não crescer
  const chaves = Object.keys(s.offsets).sort();
  if (chaves.length > 7) {
    for (const k2 of chaves.slice(0, chaves.length - 7)) delete s.offsets[k2];
  }
  salvarSeguro(s);
  return v;
}

/** Gravação tolerante: persistir a janela não pode derrubar o envio. */
function salvarSeguro(s: StoreJanela): void {
  try {
    salvar(s);
  } catch {
    /* read-only, disco cheio… segue com o valor em memória */
  }
}

export interface EstadoJanela {
  /** true = dentro da janela (envios liberados) */
  aberta: boolean;
  /** horários efetivos de hoje com o offset aplicado */
  abre: string;
  fecha: string;
  /** texto para o painel, ex.: "aberta até 22:53" */
  resumo: string;
  /** se fechada, quando reabre ("08:04") */
  reabreAs: string;
  /** offset de hoje em minutos */
  offset: number;
}

function fmt(h: number, m: number): string {
  const hh = String(Math.floor(h) % 24).padStart(2, "0");
  const mm = String(Math.round(m)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Estado completo da janela em um instante (usado pelo status/painel). */
export function estadoJanela(agora = new Date()): EstadoJanela {
  const { h, m, data } = horaLocal(agora);
  const off = offsetDoDiaPersistido(data);
  const minutos = h * 60 + m;
  const abre = 8 * 60 + off; // 08:00 ± 10
  const fecha = 23 * 60 + off; // 23:00 ± 10
  const aberta = minutos >= abre && minutos < fecha;
  return {
    aberta,
    abre: fmt(8, off),
    fecha: fmt(23, off),
    resumo: aberta
      ? `aberta até ${fmt(23, off)}`
      : `fechada — reabre às ${fmt(8, off)}`,
    reabreAs: fmt(8, off),
    offset: off,
  };
}

/**
 * O envio pode sair agora?
 * Sempre true quando MONITOR_JANELA=0 (desligada) ou em dryRun.
 */
export function podeEnviarAgora(agora = new Date()): boolean {
  if (process.env.MONITOR_JANELA === "0") return true;
  return estadoJanela(agora).aberta;
}

/**
 * Minutos restantes até a janela abrir (se fechada). Para mensagens do painel.
 */
export function minutosParaAbrir(agora = new Date()): number {
  const e = estadoJanela(agora);
  if (e.aberta) return 0;
  const { h, m } = horaLocal(agora);
  const alvo = 8 * 60 + e.offset;
  let delta = alvo - (h * 60 + m);
  if (delta <= 0) delta += 24 * 60;
  return delta;
}
