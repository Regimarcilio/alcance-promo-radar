import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const file = join(dataDir, "envios.json");

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

export function registrarEnvio(mlbId: string, preco: number, cupom?: string | null): void {
  mkdirSync(dataDir, { recursive: true });
  const arr = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  arr.push({ hash: hashEnvio(mlbId, preco, cupom), data: new Date().toISOString(), dia: diaLocal() });
  writeFileSync(file, JSON.stringify(arr, null, 2));
}
