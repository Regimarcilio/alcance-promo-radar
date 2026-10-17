/**
 * Estado do monitor (E6 / RF-035 / RN-010 / RN-013).
 * - Dedup 7d por hash `programa+idProduto+linkTransformado`.
 * - Contador de mensagens monitoradas/transformadas/encaminhadas.
 * Persistência em data/monitor-estado.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const file = join(dataDir, "monitor-estado.json");

export const DEDUP_DIAS = 7;

export interface EventoMonitor {
  em: string;
  origem: string;
  programa: string;
  idProduto: string | null;
  linkTransformado: string | null;
  destino: string | null;
  status: "ENCAMINHADA" | "DUPLICADO" | "REVISAO" | "ERRO";
  messageId?: string;
  detalhe?: string;
}

interface Estado {
  hashes: Record<string, string>; // hash → ISO do processamento
  eventos: EventoMonitor[];
}

function blank(): Estado {
  return { hashes: {}, eventos: [] };
}

function carregar(): Estado {
  try {
    if (!existsSync(file)) return blank();
    const s = JSON.parse(readFileSync(file, "utf8")) as Estado;
    return { hashes: s.hashes ?? {}, eventos: Array.isArray(s.eventos) ? s.eventos : [] };
  } catch {
    return blank();
  }
}

function salvar(s: Estado): void {
  mkdirSync(dataDir, { recursive: true });
  s.eventos = s.eventos.slice(-500); // mantém os 500 últimos eventos
  writeFileSync(file, JSON.stringify(s, null, 2));
}

export function hashMonitor(programa: string, idProduto: string | null, link: string): string {
  return createHash("sha1").update(`${programa}|${idProduto ?? ""}|${link}`).digest("hex").slice(0, 16);
}

/** Já encaminhado nos últimos 7 dias? (RF-035) */
export function jaMonitorado(programa: string, idProduto: string | null, link: string): boolean {
  const s = carregar();
  const h = hashMonitor(programa, idProduto, link);
  const quando = s.hashes[h];
  if (!quando) return false;
  const limite = Date.now() - DEDUP_DIAS * 86400_000;
  return new Date(quando).getTime() >= limite;
}

export function marcarMonitorado(programa: string, idProduto: string | null, link: string): void {
  const s = carregar();
  s.hashes[hashMonitor(programa, idProduto, link)] = new Date().toISOString();
  salvar(s);
}

export function registrarEvento(ev: EventoMonitor): void {
  const s = carregar();
  s.eventos.push(ev);
  salvar(s);
}

export function eventos(limite = 100): EventoMonitor[] {
  return carregar().eventos.slice(-limite).reverse();
}

/** Estatísticas resumidas para a interface. */
export function resumo(): {
  recebidas: number;
  encaminhadas: number;
  duplicadas: number;
  revisao: number;
  erros: number;
} {
  const evs = carregar().eventos;
  return {
    recebidas: evs.length,
    encaminhadas: evs.filter((e) => e.status === "ENCAMINHADA").length,
    duplicadas: evs.filter((e) => e.status === "DUPLICADO").length,
    revisao: evs.filter((e) => e.status === "REVISAO").length,
    erros: evs.filter((e) => e.status === "ERRO").length,
  };
}
