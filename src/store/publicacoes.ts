/**
 * RASTREIO: registro de tudo que o Alcance publica (Piloto e Monitor).
 *
 * Para onde serve:
 * - saber quantas ofertas de cada programa/categoria/grupo foram publicadas;
 * - reconciliar com o painel do programa de afiliados (Amazon mostra a venda
 *   pelo `tag`; o registro guarda o MESMO link publicado);
 * - exportar CSV para conferir no Excel/Sheets.
 *
 * Não substitui o relatório de comissão do programa de afiliados: é o nosso
 * lado "o que foi publicado", para cruzar com "o que vendeu".
 *
 * FASE 2 do ADR-012: o rastreio passou a viver no SQLite (`data/alcance.db`).
 * Motivo medido: gravar 1 publicação reescrevia o arquivo inteiro (177 ms /
 * 1,85 MB; ~1,3 s no teto de 50 mil). No banco, é um INSERT (~0,05 ms).
 *
 * Contrato de degradação (não mudou): o rastreio é ACESSÓRIO — nunca lança,
 * nunca derruba um post. Se o banco não estiver disponível:
 * - a gravação cai para o JSON (o caminho antigo), então nada se perde;
 * - a leitura cai para o JSON (snapshot), então o painel continua abrindo.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "./json.js";
import { banco } from "./db.js";

// caminho resolvido em tempo de chamada (teste/smoke trocam ALCANCE_DATA_DIR)
function file(): string {
  return join(dataDirAtual(), "publicacoes.json");
}
/** Contador histórico persistente: nunca diminui quando o arquivo é podado. */
function arquivoTotal(): string {
  return join(dataDirAtual(), "rastreio-total.json");
}

const LIMITE_PADRAO = 50_000;
const LIMITE_MINIMO = 1_000;

/** Teto de armazenamento (RASTREIO_LIMITE, default 50000, piso 1000). */
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

/* ------------------------------------------------------------------ */
/* JSON (snapshot / fallback)                                          */
/* ------------------------------------------------------------------ */

function carregarJson(): Publicacao[] {
  try {
    if (!existsSync(file())) return [];
    const j = JSON.parse(readFileSync(file(), "utf8"));
    return Array.isArray(j) ? j : Array.isArray(j?.publicacoes) ? j.publicacoes : [];
  } catch {
    return [];
  }
}

/** Grava o JSON (só usado como fallback quando o banco não está disponível). */
function salvarJson(arr: Publicacao[]): void {
  gravarJsonAtomico(file(), arr.slice(-limitePublicacoes()));
}

/** Chave idempotente da linha (dois posts do mesmo id em horas diferentes são distintos). */
function chaveDe(p: Publicacao): string {
  return createHash("sha1")
    .update([p.em, p.programa, p.grupo, p.id, p.via, p.link].join("|"))
    .digest("hex");
}

/* ------------------------------------------------------------------ */
/* Migração do JSON para o banco (uma vez, idempotente)                */
/* ------------------------------------------------------------------ */

let migrado = false;

/**
 * Importa o `publicacoes.json` para a tabela, uma única vez.
 * `INSERT OR IGNORE` + `chave` UNIQUE tornam a operação re-executável sem
 * duplicar (ex.: processo morto no meio da migração).
 */
function migrarLegado(): void {
  if (migrado) return;
  const db = banco();
  if (!db) return;
  try {
    const flag = db
      .prepare("SELECT valor FROM schema_meta WHERE chave = 'rastreio_migrado'")
      .get() as { valor: string } | undefined;
    if (!flag) {
      const arr = carregarJson();
      if (arr.length) {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO publicacoes
             (chave, em, programa, categoria, grupo, id, titulo, preco, link, tag, via)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        );
        db.exec("BEGIN");
        try {
          for (const p of arr) {
            ins.run(
              chaveDe(p),
              p.em,
              p.programa,
              p.categoria ?? null,
              p.grupo,
              p.id ?? null,
              p.titulo ?? null,
              Number.isFinite(Number(p.preco)) ? Number(p.preco) : null,
              p.link ?? null,
              p.tag ?? null,
              p.via ?? "monitor"
            );
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
      db.prepare("INSERT OR REPLACE INTO schema_meta (chave, valor) VALUES ('rastreio_migrado', '1')").run();
    }
    migrado = true;
  } catch {
    // sem flag marcada: tenta de novo na próxima chamada (nada se perde)
  }
}

/** Banco pronto para o rastreio (com a migração já aplicada) ou `null`. */
function bancoRastreio(): NonNullable<ReturnType<typeof banco>> | null {
  const db = banco();
  if (db && !migrado) migrarLegado();
  return db && migrado ? db : null;
}

/* ------------------------------------------------------------------ */
/* Contadores                                                          */
/* ------------------------------------------------------------------ */

let totalCache: number | null = null;

/** Quantas linhas existem de fato (banco ou snapshot JSON). */
function armazenados(): number {
  const db = bancoRastreio();
  if (db) {
    try {
      return Number((db.prepare("SELECT COUNT(*) AS n FROM publicacoes").get() as { n: number }).n);
    } catch {
      /* cai no JSON */
    }
  }
  return carregarJson().length;
}

/**
 * Total histórico de publicações (contador persistente, nunca diminui).
 * Migração: se o meta não existe, inicializa com o que já está armazenado.
 * Auto-correção: se o banco tiver MAIS linhas que o contador (escrita por outro
 * processo, meta antigo), o total sobe — o painel nunca mostra "publicadas"
 * menor que a lista.
 */
function totalHistorico(): number {
  const n = armazenados();
  if (totalCache === null) {
    const existeMeta = existsSync(arquivoTotal());
    const meta = lerJson<{ total?: number }>(arquivoTotal(), {});
    const registrado = Number(meta?.total);
    totalCache = Math.max(Number.isFinite(registrado) ? registrado : 0, n);
    if (!existeMeta || registrado !== totalCache) {
      try {
        gravarJsonAtomico(arquivoTotal(), { total: totalCache });
      } catch {
        /* rastreio é acessório */
      }
    }
    return totalCache;
  }
  if (n > totalCache) {
    totalCache = n;
    try {
      gravarJsonAtomico(arquivoTotal(), { total: totalCache });
    } catch {
      /* rastreio é acessório */
    }
  }
  return totalCache;
}

function gravarTotal(total: number): void {
  totalCache = total;
  try {
    gravarJsonAtomico(arquivoTotal(), { total });
  } catch {
    /* rastreio é acessório */
  }
}

/* ------------------------------------------------------------------ */
/* Escrita                                                             */
/* ------------------------------------------------------------------ */

/**
 * Registra uma publicação. Nunca lança (rastreio não pode derrubar um post).
 * Caminho normal: INSERT no SQLite. Se o banco não estiver disponível, cai
 * para o JSON — o comportamento anterior, para não perder a linha.
 */
export function registrarPublicacao(p: Publicacao): void {
  const linha: Publicacao = { ...p, em: p.em || new Date().toISOString() };
  const db = bancoRastreio();
  if (db) {
    try {
      // Total ANTES do INSERT: no primeiro registro de um banco vazio o
      // contador semearia com a linha recém-inserida e ficaria +1.
      const total = totalHistorico() + 1;
      db.prepare(
        `INSERT OR IGNORE INTO publicacoes
           (chave, em, programa, categoria, grupo, id, titulo, preco, link, tag, via)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        chaveDe(linha),
        linha.em,
        linha.programa,
        linha.categoria ?? null,
        linha.grupo,
        linha.id ?? null,
        linha.titulo ?? null,
        Number.isFinite(Number(linha.preco)) ? Number(linha.preco) : null,
        linha.link ?? null,
        linha.tag ?? null,
        linha.via ?? "monitor"
      );
      gravarTotal(total);
      podarPublicacoes(db);
      return;
    } catch {
      /* cai para o JSON */
    }
  }
  try {
    const arr = carregarJson();
    arr.push(linha);
    const total = totalHistorico() + 1;
    salvarJson(arr);
    gravarTotal(total);
  } catch {
    /* rastreio é acessório */
  }
}

/** Mantém no máximo `RASTREIO_LIMITE` linhas, apagando as mais antigas. */
function podarPublicacoes(db: NonNullable<ReturnType<typeof banco>>): void {
  try {
    const limite = limitePublicacoes();
    const n = Number((db.prepare("SELECT COUNT(*) AS n FROM publicacoes").get() as { n: number }).n);
    if (n <= limite) return;
    db.prepare(
      "DELETE FROM publicacoes WHERE seq IN (SELECT seq FROM publicacoes ORDER BY seq ASC LIMIT ?)"
    ).run(n - limite);
  } catch {
    /* poda é acessória */
  }
}

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

export interface FiltroRastreio {
  programa?: string;
  categoria?: string;
  grupo?: string;
  dias?: number;
  via?: string;
  /** teto de linhas devolvidas (evita carregar 50 mil para mostrar 300) */
  limite?: number;
}

function onde(f: FiltroRastreio): { sql: string; params: (string | number)[] } {
  const cond: string[] = [];
  const params: (string | number)[] = [];
  if (f.programa) {
    cond.push("programa = ?");
    params.push(f.programa);
  }
  if (f.categoria) {
    cond.push("categoria = ?");
    params.push(f.categoria);
  }
  if (f.grupo) {
    cond.push("grupo = ?");
    params.push(f.grupo);
  }
  if (f.via) {
    cond.push("via = ?");
    params.push(f.via);
  }
  if (f.dias && f.dias > 0) {
    cond.push("em >= ?");
    params.push(new Date(Date.now() - f.dias * 86_400_000).toISOString());
  }
  return { sql: cond.length ? `WHERE ${cond.join(" AND ")}` : "", params };
}

function mapear(row: Record<string, unknown>): Publicacao {
  return {
    em: String(row.em),
    programa: String(row.programa) as ProgramaPub,
    categoria: row.categoria === null || row.categoria === undefined ? "" : String(row.categoria),
    grupo: String(row.grupo),
    id: row.id === null || row.id === undefined ? "" : String(row.id),
    titulo: row.titulo === null || row.titulo === undefined ? "" : String(row.titulo),
    preco: Number(row.preco ?? 0),
    link: row.link === null || row.link === undefined ? "" : String(row.link),
    tag: row.tag === null || row.tag === undefined || row.tag === "" ? undefined : String(row.tag),
    via: (row.via === "piloto" ? "piloto" : "monitor") as "piloto" | "monitor",
  };
}

/** Publicações filtradas (mais recentes primeiro). */
export function listarPublicacoes(f: FiltroRastreio = {}): Publicacao[] {
  const db = bancoRastreio();
  if (db) {
    try {
      const w = onde(f);
      const limite = f.limite && f.limite > 0 ? Math.floor(f.limite) : -1;
      const rows = db
        .prepare(
          `SELECT * FROM publicacoes ${w.sql} ORDER BY em DESC, seq DESC${limite > 0 ? " LIMIT ?" : ""}`
        )
        .all(...w.params, ...(limite > 0 ? [limite] : [])) as Record<string, unknown>[];
      return rows.map(mapear);
    } catch {
      /* cai para o JSON */
    }
  }
  // Fallback: snapshot JSON (mesma semântica do código anterior).
  const desde = f.dias ? Date.now() - f.dias * 86_400_000 : 0;
  const out = carregarJson()
    .filter((p) => {
      if (f.programa && p.programa !== f.programa) return false;
      if (f.categoria && p.categoria !== f.categoria) return false;
      if (f.grupo && p.grupo !== f.grupo) return false;
      if (f.via && p.via !== f.via) return false;
      if (desde && new Date(p.em).getTime() < desde) return false;
      return true;
    })
    .reverse();
  return f.limite && f.limite > 0 ? out.slice(0, f.limite) : out;
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
  const db = bancoRastreio();
  if (db) {
    try {
      const w = onde(f);
      const agrupar = (col: string): Record<string, number> => {
        const rows = db
          .prepare(
            `SELECT COALESCE(${col}, '(vazio)') AS k, COUNT(*) AS n FROM publicacoes ${w.sql} GROUP BY k`
          )
          .all(...w.params) as { k: string; n: number }[];
        return Object.fromEntries(rows.map((r) => [String(r.k), Number(r.n)]));
      };
      const comTagSql = w.sql
        ? `${w.sql} AND tag IS NOT NULL AND tag <> ''`
        : "WHERE tag IS NOT NULL AND tag <> ''";
      const comTag = Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM publicacoes ${comTagSql}`).get(...w.params) as { n: number }).n
      );
      return {
        total: totalHistorico(),
        armazenados: armazenados(),
        limite: limitePublicacoes(),
        porPrograma: agrupar("programa"),
        porCategoria: agrupar("categoria"),
        porGrupo: agrupar("grupo"),
        comTag,
      };
    } catch {
      /* cai para o JSON */
    }
  }
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
    armazenados: armazenados(),
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
      ].join(";")
    ),
  ].join("\n");
}

/** Força a migração do JSON agora (boot) e devolve quantas linhas há no banco. */
export function prepararRastreio(): { migrado: boolean; armazenados: number; total: number } {
  const db = bancoRastreio();
  if (!db) return { migrado: false, armazenados: carregarJson().length, total: totalHistorico() };
  return { migrado, armazenados: armazenados(), total: totalHistorico() };
}
