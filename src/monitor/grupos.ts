/**
 * Grupos monitorados + destinos (E6 / RF-030).
 * Fonte: mensagens de grupos de afiliados → transforma → encaminha para os grupos próprios.
 * Persistência em data/monitor.json (git-ignored, chmod 600).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_MONITOR_GRUPOS = 10;

export interface GrupoMonitor {
  jid: string; // "120363...@g.us"
  nome: string;
  ativo: boolean;
  criadoEm: string;
}

export interface MonitorStore {
  origens: GrupoMonitor[]; // até 10 grupos que eu monitoro
  destinos: GrupoMonitor[]; // até 10 grupos meus (para onde encaminho)
  autoEnviar: boolean; // false = vai para fila de revisão
  criadoEm: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const file = join(dataDir, "monitor.json");

function blank(): MonitorStore {
  return { origens: [], destinos: [], autoEnviar: false, criadoEm: new Date().toISOString() };
}

/** Semeia origens/destinos a partir de MONITOR_GRUPOS / MONITOR_DESTINOS (CSV de JIDs). */
function seedEnv(s: MonitorStore): MonitorStore {
  if (s.origens.length === 0) {
    const csv = process.env.MONITOR_GRUPOS?.trim();
    if (csv) {
      s.origens = csv.split(",").map((j) => normalizarJid(j)).filter(Boolean).slice(0, MAX_MONITOR_GRUPOS)
        .map((jid) => ({ jid, nome: jid, ativo: true, criadoEm: new Date().toISOString() }));
    }
  }
  if (s.destinos.length === 0) {
    const csv = process.env.MONITOR_DESTINOS?.trim();
    if (csv) {
      s.destinos = csv.split(",").map((j) => normalizarJid(j)).filter(Boolean).slice(0, MAX_MONITOR_GRUPOS)
        .map((jid) => ({ jid, nome: jid, ativo: true, criadoEm: new Date().toISOString() }));
    }
  }
  return s;
}

export function carregarMonitor(): MonitorStore {
  try {
    if (!existsSync(file)) return seedEnv(blank());
    const s = JSON.parse(readFileSync(file, "utf8")) as MonitorStore;
    return seedEnv({
      origens: Array.isArray(s.origens) ? s.origens : [],
      destinos: Array.isArray(s.destinos) ? s.destinos : [],
      autoEnviar: !!s.autoEnviar,
      criadoEm: s.criadoEm ?? new Date().toISOString(),
    });
  } catch {
    return seedEnv(blank());
  }
}

function salvar(s: MonitorStore): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

/** Normaliza JID: aceita "123@g.us" ou só os dígitos. */
export function normalizarJid(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s.endsWith("@g.us")) return s;
  const digits = s.replace(/\D/g, "");
  return digits ? `${digits}@g.us` : "";
}

export function adicionarOrigem(jidRaw: string, nome = ""): GrupoMonitor {
  const jid = normalizarJid(jidRaw);
  if (!jid) throw new Error("JID inválido (use 120363...@g.us ou os dígitos do grupo).");
  const s = carregarMonitor();
  if (s.origens.length >= MAX_MONITOR_GRUPOS) throw new Error(`Limite de ${MAX_MONITOR_GRUPOS} grupos monitorados.`);
  const i = s.origens.findIndex((g) => g.jid === jid);
  const g: GrupoMonitor = {
    jid,
    nome: nome.trim() || jid,
    ativo: true,
    criadoEm: i >= 0 ? s.origens[i].criadoEm : new Date().toISOString(),
  };
  if (i >= 0) s.origens[i] = g;
  else s.origens.push(g);
  salvar(s);
  return g;
}

export function adicionarDestino(jidRaw: string, nome = ""): GrupoMonitor {
  const jid = normalizarJid(jidRaw);
  if (!jid) throw new Error("JID inválido (use 120363...@g.us ou os dígitos do grupo).");
  const s = carregarMonitor();
  if (s.destinos.length >= MAX_MONITOR_GRUPOS) throw new Error(`Limite de ${MAX_MONITOR_GRUPOS} grupos de destino.`);
  const i = s.destinos.findIndex((g) => g.jid === jid);
  const g: GrupoMonitor = {
    jid,
    nome: nome.trim() || jid,
    ativo: true,
    criadoEm: i >= 0 ? s.destinos[i].criadoEm : new Date().toISOString(),
  };
  if (i >= 0) s.destinos[i] = g;
  else s.destinos.push(g);
  salvar(s);
  return g;
}

export function remover(tipo: "origem" | "destino", jidRaw: string): void {
  const jid = normalizarJid(jidRaw);
  const s = carregarMonitor();
  if (tipo === "origem") s.origens = s.origens.filter((g) => g.jid !== jid);
  else s.destinos = s.destinos.filter((g) => g.jid !== jid);
  salvar(s);
}

export function definirAutoEnviar(v: boolean): void {
  const s = carregarMonitor();
  s.autoEnviar = !!v;
  salvar(s);
}

/** O grupo está na lista de origens ativas? (RF-030 / RN-012) */
export function ehMonitorado(jidRaw: string): boolean {
  const jid = normalizarJid(jidRaw);
  return carregarMonitor().origens.some((g) => g.jid === jid && g.ativo);
}

/** Destinos ativos, excluindo o grupo de origem (anti-loop — RN-010). */
export function destinosPara(origemJid: string): GrupoMonitor[] {
  const jid = normalizarJid(origemJid);
  return carregarMonitor().destinos.filter((g) => g.ativo && g.jid !== jid);
}
