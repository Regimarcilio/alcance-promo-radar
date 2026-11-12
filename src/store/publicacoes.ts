/**
 * RASTREIO: registro de tudo que o Alcance publica (Piloto e Monitor).
 *
 * Para onde serve:
 * - saber quantas ofertas de cada programa/categoria/grupo foram publicadas;
 * - reconciliar com o painel do programa de afiliados (Amazon mostra a venda
 *   pelo `tag`; o registro guarda o MESMO link publicado);
 * - exportar CSV para conferir no Excel/Sheets.
 *
 * Não substitui o relatório de comissão do programa de afiliados: é a nossa
 * lado "o que foi publicado", para cruzar com "o que vendeu".
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "./json.js";

// caminho resolvido em tempo de chamada (teste/smoke trocam ALCANCE_DATA_DIR)
function file(): string {
  return join(dataDirAtual(), "publicacoes.json");
}
/** Contador histórico persistente: nunca diminui quando o arquivo é podado. */
const arquivoTotal = join(dataDirAtual(), "rastreio-total.json");

const LIMITE_PADRAO = 50_000;
const LIMITE_MINIMO = 1_000;

/** Teto de armazenamento do arquivo (RASTREIO_LIMITE, default 50000, piso 1000). */
export function limitePublicacoes(): number {
  const n = Number(process.env.RASTREIO_LIMITE ?? LIMITE_PADRAO);
  const v = Number.isFinite(n) ? Math.floor(n) : LIMITE_PADRAO;
  return Math.max(LIMITE_MINIMO, v);
}

export type ProgramaPub = "ml" | "shopee" | "amazon" | "kabum" | "desconhecido";

export interface Publicacao {
  em: string;
  /** programa de afiliado da oferta */
  programa: ProgramaPub;
  /** categoria do Alcance (MLBxxxx / AMxxxx) */
  categoria: string;
  /** nome do grupo que recebeu */
  grupo: string;
  /** id do produto: MLB-123 / ASIN / etc. */
  id: string;
  titulo: string;
  preco: number;
  /** link EXATAMENTE publicado (com a tag de rastreio) */
  link: string;
  /** tag de rastreio usada (Amazon) */
  tag?: string;
  /** origem da publicação: piloto | monitor */
  via: "piloto" | "monitor";
}

function carregar(): Publicacao[] {
  try {
    if (!existsSync(file())) return [];
    const j = JSON.parse(readFileSync(file(), "utf8"));
    return Array.isArray(j) ? j : Array.isArray(j?.publicacoes) ? j.publicacoes : [];
  } catch {
    return [];
  }
}

function salvar(arr: Publicacao[]): void {
  gravarJsonAtomico(file(), arr.slice(-limitePublicacoes()));
}

let totalCache: number | null = null;

/**
 * Total histórico de publicações (contador persistente, nunca diminui).
 * Migração: se o meta não existe, inicializa com o tamanho atual do arquivo.
 */
function totalHistorico(): number {
  if (totalCache !== null) return totalCache;
  const armazenados = carregar().length;
  const existeMeta = existsSync(arquivoTotal);
  const meta = lerJson<{ total?: number }>(arquivoTotal, {});
  const registrado = Number(meta?.total);
  const total = Math.max(Number.isFinite(registrado) ? registrado : 0, armazenados);
  // grava se o meta não existia ou se ficou abaixo do arquivo (nunca retrocede)
  if (!existeMeta || registrado !== total) {
    try {
      gravarJsonAtomico(arquivoTotal, { total });
    } catch {
      /* rastreio é acessório */
    }
  }
  totalCache = total;
  return total;
}

function gravarTotal(total: number): void {
  totalCache = total;
  gravarJsonAtomico(arquivoTotal, { total });
}

/** Registra uma publicação. Nunca lança (rastreio não pode derrubar um post). */
export function registrarPublicacao(p: Publicacao): void {
  try {
    const arr = carregar();
    arr.push({ ...p, em: p.em || new Date().toISOString() });
    const total = totalHistorico() + 1;
    salvar(arr);
    gravarTotal(total);
  } catch {
    /* rastreio é acessório */
  }
}

export interface FiltroRastreio {
  programa?: string;
  categoria?: string;
  grupo?: string;
  dias?: number;
  via?: string;
}

/** Publicações filtradas (mais recentes primeiro). */
export function listarPublicacoes(f: FiltroRastreio = {}): Publicacao[] {
  const arr = carregar();
  const desde = f.dias ? Date.now() - f.dias * 86400000 : 0;
  return arr
    .filter((p) => {
      if (f.programa && p.programa !== f.programa) return false;
      if (f.categoria && p.categoria !== f.categoria) return false;
      if (f.grupo && p.grupo !== f.grupo) return false;
      if (f.via && p.via !== f.via) return false;
      if (desde && new Date(p.em).getTime() < desde) return false;
      return true;
    })
    .reverse();
}

/** Resumo por programa/categoria/grupo (para os cards do painel). */
export function resumoRastreio(f: FiltroRastreio = {}): {
  total: number;
  armazenados: number;
  limite: number;
  porPrograma: Record<string, number>;
  porCategoria: Record<string, number>;
  porGrupo: Record<string, number>;
  comTag: number;
} {
  const pubs = listarPublicacoes(f);
  const porPrograma: Record<string, number> = {};
  const porCategoria: Record<string, number> = {};
  const porGrupo: Record<string, number> = {};
  let comTag = 0;
  for (const p of pubs) {
    porPrograma[p.programa] = (porPrograma[p.programa] ?? 0) + 1;
    porCategoria[p.categoria] = (porCategoria[p.categoria] ?? 0) + 1;
    porGrupo[p.grupo] = (porGrupo[p.grupo] ?? 0) + 1;
    if (p.tag) comTag++;
  }
  return {
    total: totalHistorico(),
    armazenados: carregar().length,
    limite: limitePublicacoes(),
    porPrograma,
    porCategoria,
    porGrupo,
    comTag,
  };
}

/** CSV para abrir no Excel (separador ;, padrão do Excel em pt-BR). */
export function publicacoesCsv(f: FiltroRastreio = {}): string {
  const linhas = listarPublicacoes(f);
  const cab = ["data", "programa", "categoria", "grupo", "id", "titulo", "preco", "tag", "via", "link"];
  // Anti formula/CSV injection: campos iniciados por = + - @ TAB CR são
  // prefixados com apóstrofo para o Excel/LibreOffice não executarem nada.
  const esc = (v: unknown) => {
    let t = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  return [
    cab.join(";"),
    ...linhas.map((p) =>
      [
        esc(new Date(p.em).toLocaleString("pt-BR")),
        esc(p.programa),
        esc(p.categoria),
        esc(p.grupo),
        esc(p.id),
        esc(p.titulo),
        esc(p.preco),
        esc(p.tag ?? ""),
        esc(p.via),
        esc(p.link),
      ].join(";"),
    ),
  ].join("\n");
}
