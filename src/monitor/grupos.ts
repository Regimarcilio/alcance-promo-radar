/**
 * Regras do MODO MONITOR (E6 / RF-030).
 * Cada ORIGEM (grupo de afiliados que eu monitoro) tem os SEUS destinos —
 * porque cada grupo publica uma categoria específica. A mensagem de uma origem
 * só vai para os destinos daquela origem (não vira "tudo para todos").
 * Persistência em data/monitor.json (git-ignored, chmod 600).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_MONITOR_GRUPOS = 10; // máx de origens
export const MAX_DESTINOS_POR_ORIGEM = 10;

export interface GrupoMonitor {
  jid: string; // "120363...@g.us"
  nome: string;
  ativo: boolean;
  criadoEm: string;
}

/** Uma regra = 1 origem + os destinos dela. */
export interface Regra {
  origem: GrupoMonitor;
  destinos: GrupoMonitor[];
  criadoEm: string;
}

export interface MonitorStore {
  regras: Regra[];
  autoEnviar: boolean; // false = vai para fila de revisão
  criadoEm: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const file = join(dataDir, "monitor.json");

function blank(): MonitorStore {
  return { regras: [], autoEnviar: false, criadoEm: new Date().toISOString() };
}

/** Normaliza JID: aceita "123@g.us" ou só os dígitos. */
export function normalizarJid(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (s.endsWith("@g.us")) return s;
  const digits = s.replace(/\D/g, "");
  return digits ? `${digits}@g.us` : "";
}

function novoGrupo(jid: string, nome: string): GrupoMonitor {
  return { jid, nome: (nome ?? "").trim() || jid, ativo: true, criadoEm: new Date().toISOString() };
}

/**
 * Migra o formato antigo (origens[] + destinos[] globais) para regras.
 * Cada origem antiga recebe todos os destinos antigos (melhor esforço; o
 * usuário reconfigura pela UI). Mantido só para não perder config existente.
 */
function migrar(antigo: any): MonitorStore {
  const s = blank();
  const origens: any[] = Array.isArray(antigo?.origens) ? antigo.origens : [];
  const destinos: any[] = Array.isArray(antigo?.destinos) ? antigo.destinos : [];
  for (const o of origens) {
    const oj = normalizarJid(o?.jid ?? "");
    if (!oj) continue;
    s.regras.push({
      origem: { jid: oj, nome: o?.nome ?? oj, ativo: o?.ativo !== false, criadoEm: o?.criadoEm ?? new Date().toISOString() },
      destinos: destinos
        .map((d) => ({ jid: normalizarJid(d?.jid ?? ""), nome: d?.nome ?? "", ativo: d?.ativo !== false, criadoEm: d?.criadoEm ?? new Date().toISOString() }))
        .filter((d) => d.jid && d.jid !== oj),
      criadoEm: o?.criadoEm ?? new Date().toISOString(),
    });
  }
  s.autoEnviar = !!antigo?.autoEnviar;
  return s;
}

/** Semeia as primeiras regras a partir de MONITOR_GRUPOS / MONITOR_DESTINOS (CSV de JIDs). */
function seedEnv(s: MonitorStore): MonitorStore {
  if (s.regras.length > 0) return s;
  const origensCsv = process.env.MONITOR_GRUPOS?.trim();
  const destCsv = process.env.MONITOR_DESTINOS?.trim();
  if (!origensCsv) return s;
  const destinos = destCsv
    ? destCsv.split(",").map((j) => normalizarJid(j)).filter(Boolean).slice(0, MAX_DESTINOS_POR_ORIGEM)
    : [];
  for (const jid of origensCsv.split(",").map((j) => normalizarJid(j)).filter(Boolean).slice(0, MAX_MONITOR_GRUPOS)) {
    s.regras.push({ origem: novoGrupo(jid, jid), destinos: destinos.map((d) => ({ ...novoGrupo(d, d) })), criadoEm: new Date().toISOString() });
  }
  return s;
}

export function carregarMonitor(): MonitorStore {
  try {
    if (!existsSync(file)) return seedEnv(blank());
    const raw: any = JSON.parse(readFileSync(file, "utf8"));
    // formato novo
    if (Array.isArray(raw?.regras)) {
      const s: MonitorStore = {
        regras: raw.regras
          .map((r: any): Regra => ({
            origem: {
              jid: normalizarJid(r?.origem?.jid ?? ""),
              nome: r?.origem?.nome ?? r?.origem?.jid ?? "",
              ativo: r?.origem?.ativo !== false,
              criadoEm: r?.origem?.criadoEm ?? new Date().toISOString(),
            },
            destinos: (Array.isArray(r?.destinos) ? r.destinos : [])
              .map((d: any) => ({
                jid: normalizarJid(d?.jid ?? ""),
                nome: d?.nome ?? d?.jid ?? "",
                ativo: d?.ativo !== false,
                criadoEm: d?.criadoEm ?? new Date().toISOString(),
              }))
              .filter((d: GrupoMonitor) => d.jid),
            criadoEm: r?.criadoEm ?? new Date().toISOString(),
          }))
          .filter((r: Regra) => r.origem.jid),
        autoEnviar: !!raw.autoEnviar,
        criadoEm: raw.criadoEm ?? new Date().toISOString(),
      };
      return s;
    }
    // formato antigo → migra
    return migrar(raw);
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

/**
 * Adiciona uma regra "um de cada vez": liga UMA origem a UM destino.
 * Se a origem já existir, apenas acrescenta o destino a ela.
 */
export function adicionarRegra(origemRaw: string, origemNome: string, destinoRaw: string, destinoNome: string): Regra {
  const oj = normalizarJid(origemRaw);
  const dj = normalizarJid(destinoRaw);
  if (!oj) throw new Error("Origem inválida (use 120363...@g.us ou os dígitos do grupo).");
  if (!dj) throw new Error("Destino inválido (use 120363...@g.us ou os dígitos do grupo).");
  if (oj === dj) throw new Error("Origem e destino não podem ser o mesmo grupo.");

  const s = carregarMonitor();
  let regra = s.regras.find((r) => r.origem.jid === oj);
  if (!regra) {
    if (s.regras.length >= MAX_MONITOR_GRUPOS) throw new Error(`Limite de ${MAX_MONITOR_GRUPOS} origens monitoradas.`);
    regra = { origem: novoGrupo(oj, origemNome), destinos: [], criadoEm: new Date().toISOString() };
    s.regras.push(regra);
  } else if (origemNome?.trim()) {
    regra.origem.nome = origemNome.trim();
  }
  if (!regra.destinos.some((d) => d.jid === dj)) {
    if (regra.destinos.length >= MAX_DESTINOS_POR_ORIGEM) throw new Error(`Limite de ${MAX_DESTINOS_POR_ORIGEM} destinos para esta origem.`);
    regra.destinos.push(novoGrupo(dj, destinoNome));
  } else if (destinoNome?.trim()) {
    const d = regra.destinos.find((x) => x.jid === dj)!;
    d.nome = destinoNome.trim();
  }
  salvar(s);
  return regra;
}

/** Remove um destino específico de uma origem. */
export function removerDestino(origemRaw: string, destinoRaw: string): void {
  const oj = normalizarJid(origemRaw);
  const dj = normalizarJid(destinoRaw);
  const s = carregarMonitor();
  const regra = s.regras.find((r) => r.origem.jid === oj);
  if (regra) regra.destinos = regra.destinos.filter((d) => d.jid !== dj);
  salvar(s);
}

/** Remove a regra inteira (a origem e todas as suas amarrações). */
export function removerRegra(origemRaw: string): void {
  const oj = normalizarJid(origemRaw);
  const s = carregarMonitor();
  s.regras = s.regras.filter((r) => r.origem.jid !== oj);
  salvar(s);
}

export function definirAutoEnviar(v: boolean): void {
  const s = carregarMonitor();
  s.autoEnviar = !!v;
  salvar(s);
}

export function listarRegras(): Regra[] {
  return carregarMonitor().regras;
}

/** O grupo é origem de alguma regra ativa? (RF-030 / RN-012) */
export function ehMonitorado(jidRaw: string): boolean {
  const jid = normalizarJid(jidRaw);
  return carregarMonitor().regras.some((r) => r.origem.jid === jid && r.origem.ativo);
}

/** Destinos da regra daquela origem (exclui a própria origem — anti-loop RN-010). */
export function destinosPara(origemJid: string): GrupoMonitor[] {
  const jid = normalizarJid(origemJid);
  const regra = carregarMonitor().regras.find((r) => r.origem.jid === jid);
  if (!regra) return [];
  return regra.destinos.filter((d) => d.ativo && d.jid !== jid);
}
