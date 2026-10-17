/**
 * Estado do monitor (E6 / RF-035 / RN-010 / RN-013).
 * - Dedup 7d por hash `programa+idProduto+linkTransformado`.
 * - Contador de mensagens monitoradas/transformadas/encaminhadas.
 * Persistência em data/monitor-estado.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
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
  status: "ENCAMINHADA" | "DUPLICADO" | "REVISAO" | "ERRO" | "ENFILEIRADA";
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

// Última leitura boa: evita que um erro transitório de I/O (arquivo em escrita)
// devolva estado vazio e a próxima gravação persista o vazio (perda de eventos/dedup).
let cache: Estado | null = null;

function carregar(): Estado {
  try {
    if (!existsSync(file)) return cache ?? blank();
    const s = JSON.parse(readFileSync(file, "utf8")) as Estado;
    cache = { hashes: s.hashes ?? {}, eventos: Array.isArray(s.eventos) ? s.eventos : [] };
    return cache;
  } catch {
    return cache ?? blank();
  }
}

function salvar(s: Estado): void {
  mkdirSync(dataDir, { recursive: true });
  s.eventos = s.eventos.slice(-500); // mantém os 500 últimos eventos
  cache = s;
  // Escrita atômica (tmp + rename): nunca deixa o arquivo meio-escrito.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

export function hashMonitor(programa: string, idProduto: string | null, link: string): string {
  // Com id do produto, o link gerado é descartado (createLink devolve um link
  // NOVO a cada chamada — sem isso, o mesmo produto postado 2x duplicaria).
  const chave = idProduto ? `${programa}|${idProduto}` : `${programa}|#link|${link}`;
  return createHash("sha1").update(chave).digest("hex").slice(0, 16);
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

/** Zera os contadores (limpa o histórico de eventos). Mantém regras e dedup. */
export function zerarContadores(): number {
  const s = carregar();
  const n = s.eventos.length;
  s.eventos = [];
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

/** Estatísticas resumidas para a interface. */
export function resumo(): {
  recebidas: number;
  encaminhadas: number;
  duplicadas: number;
  revisao: number;
  erros: number;
  enfileiradas: number;
} {
  const evs = carregar().eventos;
  return {
    recebidas: evs.length,
    encaminhadas: evs.filter((e) => e.status === "ENCAMINHADA").length,
    duplicadas: evs.filter((e) => e.status === "DUPLICADO").length,
    revisao: evs.filter((e) => e.status === "REVISAO").length,
    erros: evs.filter((e) => e.status === "ERRO").length,
    enfileiradas: evs.filter((e) => e.status === "ENFILEIRADA").length,
  };
}
