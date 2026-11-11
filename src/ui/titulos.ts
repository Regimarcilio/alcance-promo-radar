/**
 * Títulos dos cards do painel (editáveis pela UI) — data/ui.json.
 * Serve para renomear cada painel (piloto, monitor, números, clientes) sem
 * mexer no código, deixando espaço para melhorias futuras por card.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const file = join(dataDir, "ui.json");

export const TITULOS_PADRAO: Record<string, string> = {
  piloto: "🚀 Piloto automático",
  monitor: "📡 Monitor",
  numeros: "📱 Números",
  clientes: "👥 Clientes",
};

let cache: Record<string, string> | null = null;

export function lerTitulos(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw: any = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    cache = { ...TITULOS_PADRAO, ...(raw?.titulos ?? {}) };
  } catch {
    cache = { ...TITULOS_PADRAO };
  }
  return cache!;
}

export function definirTitulo(chave: string, titulo: string): Record<string, string> {
  const t = lerTitulos();
  const limpo = String(titulo ?? "").trim().slice(0, 60);
  if (!limpo) throw new Error("título vazio");
  if (!(chave in TITULOS_PADRAO)) throw new Error(`card desconhecido: ${chave}`);
  t[String(chave)] = limpo;
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ titulos: t }, null, 2));
    renameSync(tmp, file);
  } catch {
    /* ignore */
  }
  return t;
}
