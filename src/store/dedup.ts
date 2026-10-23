import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico } from "./json.js";

const file = join(dataDirAtual(), "envios.json");

export function hashEnvio(mlbId: string, preco: number, cupom?: string | null): string {
  return `${mlbId}|${preco}|${(cupom ?? "").toUpperCase()}`;
}

/** Dia local (America/Sao_Paulo) em YYYY-MM-DD — o limite diário e o
 *  dedup usam o dia DE QUEM OPERA, nunca UTC (bug que pausava à toa). */
export function diaLocal(d: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** Anti-duplicidade 7 dias (RN-010). Retorna true se já enviado. */
export function jaEnviado(mlbId: string, preco: number, cupom?: string | null, dias = 7): boolean {
  if (!existsSync(file)) return false;
  try {
    const arr: { hash: string; data: string }[] = JSON.parse(readFileSync(file, "utf8"));
    const h = hashEnvio(mlbId, preco, cupom);
    const corte = Date.now() - dias * 86400000;
    return arr.some((e) => e.hash === h && new Date(e.data).getTime() >= corte);
  } catch {
    return false;
  }
}

export function registrarEnvio(mlbId: string, preco: number, cupom?: string | null, dias = 7): void {
  let arr: { hash: string; data: string; dia?: string }[] = [];
  try {
    arr = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  const corte = Date.now() - dias * 86_400_000;
  arr = arr.filter((e) => new Date(e.data).getTime() >= corte);
  arr.push({ hash: hashEnvio(mlbId, preco, cupom), data: new Date().toISOString(), dia: diaLocal() });
  gravarJsonAtomico(file, arr);
}
