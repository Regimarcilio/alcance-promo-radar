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
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const file = join(dataDir, "publicacoes.json");

/** Mantém as últimas N publicações (o arquivo não cresce sem limite). */
export const LIMITE_PUBLICACOES = 5000;

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
    if (!existsSync(file)) return [];
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : Array.isArray(j?.publicacoes) ? j.publicacoes : [];
  } catch {
    return [];
  }
}

function salvar(arr: Publicacao[]): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(arr.slice(-LIMITE_PUBLICACOES), null, 2));
  renameSync(tmp, file); // escrita atômica: nunca deixa o arquivo meio escrito
}

/** Registra uma publicação. Nunca lança (rastreio não pode derrubar um post). */
export function registrarPublicacao(p: Publicacao): void {
  try {
    const arr = carregar();
    arr.push({ ...p, em: p.em || new Date().toISOString() });
    salvar(arr);
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
  return { total: pubs.length, porPrograma, porCategoria, porGrupo, comTag };
}

/** CSV para abrir no Excel (separador ;, padrão do Excel em pt-BR). */
export function publicacoesCsv(f: FiltroRastreio = {}): string {
  const linhas = listarPublicacoes(f);
  const cab = ["data", "programa", "categoria", "grupo", "id", "titulo", "preco", "tag", "via", "link"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
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
