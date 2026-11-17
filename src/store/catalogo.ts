/**
 * CATÁLOGO de ofertas recebidas dos grupos de origem.
 *
 * O que resolve (ADR-012): hoje o Alcance só guarda o que **encaminhou**
 * (`publicacoes.json`). O que chegou e foi descartado — duplicado, fora de
 * janela, programa sem suporte, link inválido — desaparece, sobrando só um
 * SHA1 por 7 dias. Sem catálogo não existe "filtrar o histórico e reenviar em
 * lote", nem auditoria do que os grupos publicaram.
 *
 * Este módulo grava **toda** oferta recebida, inclusive a não encaminhada, com
 * o desfecho e o motivo. É acessório por contrato: `registrarOferta` nunca
 * lança. Se o banco estiver fora, o Monitor segue exatamente como antes.
 */
import { randomUUID } from "node:crypto";
import { banco } from "./db.js";

export type Desfecho =
  | "IGNORADO"
  | "DUPLICADO"
  | "REVISAO"
  | "ENCAMINHADO"
  | "ENFILEIRADO"
  | "REAGENDADO"
  | "ERRO";

export interface OfertaRecebida {
  id: string;
  recebidaEm: string;
  origem: string;
  programa: string | null;
  idProduto: string | null;
  titulo: string | null;
  preco: number | null;
  precoDe: number | null;
  link: string | null;
  cupom: string | null;
  imagem: string | null;
  mensagem: string | null;
  texto: string | null;
  temMidia: boolean;
  desfecho: Desfecho;
  motivo: string | null;
}

export interface RegistroOferta {
  id?: string;
  recebidaEm?: string;
  origem: string;
  programa?: string | null;
  idProduto?: string | null;
  titulo?: string | null;
  preco?: number | null;
  precoDe?: number | null;
  link?: string | null;
  cupom?: string | null;
  imagem?: string | null;
  mensagem?: string | null;
  texto?: string | null;
  temMidia?: boolean;
  desfecho: Desfecho;
  motivo?: string | null;
}

export interface FiltroCatalogo {
  programa?: string;
  origem?: string;
  desfecho?: string;
  precoMin?: number;
  precoMax?: number;
  /** Busca livre em título, texto e link (LIKE, case-insensitive nos ASCII). */
  busca?: string;
  dias?: number;
  pagina?: number;
  porPagina?: number;
}

export interface PaginaCatalogo {
  total: number;
  pagina: number;
  porPagina: number;
  itens: OfertaRecebida[];
}

export interface ResumoCatalogo {
  total: number;
  porDesfecho: Record<string, number>;
  porPrograma: Record<string, number>;
  porOrigem: Record<string, number>;
}

const MAX_POR_PAGINA = 500;

function texto(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Grava a oferta recebida. **Nunca lança** — devolve o id gravado ou `null` se
 * o banco estiver desligado/indisponível (degradação segura, ADR-012 §5).
 */
export function registrarOferta(r: RegistroOferta): string | null {
  const db = banco();
  if (!db) return null;
  const id = r.id ?? randomUUID();
  try {
    db.prepare(
      `INSERT OR REPLACE INTO ofertas
         (id, recebida_em, origem, programa, id_produto, titulo, preco, preco_de,
          link, cupom, imagem, mensagem, texto, tem_midia, desfecho, motivo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      r.recebidaEm ?? new Date().toISOString(),
      texto(r.origem) ?? "desconhecida",
      texto(r.programa),
      texto(r.idProduto),
      texto(r.titulo),
      numero(r.preco),
      numero(r.precoDe),
      texto(r.link),
      texto(r.cupom),
      texto(r.imagem),
      texto(r.mensagem),
      r.texto ?? null,
      r.temMidia ? 1 : 0,
      r.desfecho,
      texto(r.motivo)
    );
    return id;
  } catch {
    // Catálogo é acessório: nunca derruba o recebimento da oferta.
    return null;
  }
}

/** Monta WHERE + parâmetros (colunas fixas; valores sempre por binding). */
function onde(f: FiltroCatalogo): { sql: string; params: (string | number)[] } {
  const cond: string[] = [];
  const params: (string | number)[] = [];
  if (f.programa) {
    cond.push("programa = ?");
    params.push(f.programa);
  }
  if (f.origem) {
    cond.push("origem = ?");
    params.push(f.origem);
  }
  if (f.desfecho) {
    cond.push("desfecho = ?");
    params.push(f.desfecho);
  }
  if (f.precoMin !== undefined && Number.isFinite(f.precoMin)) {
    cond.push("preco >= ?");
    params.push(f.precoMin);
  }
  if (f.precoMax !== undefined && Number.isFinite(f.precoMax)) {
    cond.push("preco <= ?");
    params.push(f.precoMax);
  }
  if (f.dias && f.dias > 0) {
    cond.push("recebida_em >= ?");
    params.push(new Date(Date.now() - f.dias * 86_400_000).toISOString());
  }
  const busca = (f.busca ?? "").trim();
  if (busca) {
    const like = `%${busca.slice(0, 120)}%`;
    cond.push("(titulo LIKE ? OR texto LIKE ? OR link LIKE ? OR id_produto LIKE ?)");
    params.push(like, like, like, like);
  }
  return { sql: cond.length ? `WHERE ${cond.join(" AND ")}` : "", params };
}

function mapear(row: Record<string, unknown>): OfertaRecebida {
  return {
    id: String(row.id),
    recebidaEm: String(row.recebida_em),
    origem: String(row.origem),
    programa: texto(row.programa),
    idProduto: texto(row.id_produto),
    titulo: texto(row.titulo),
    preco: numero(row.preco),
    precoDe: numero(row.preco_de),
    link: texto(row.link),
    cupom: texto(row.cupom),
    imagem: texto(row.imagem),
    mensagem: texto(row.mensagem),
    texto: texto(row.texto),
    temMidia: Number(row.tem_midia) === 1,
    desfecho: String(row.desfecho) as Desfecho,
    motivo: texto(row.motivo),
  };
}

/** Uma oferta pelo id (para o reenvio manual). `null` se não existir. */
export function obterOferta(id: string): OfertaRecebida | null {
  const db = banco();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT * FROM ofertas WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapear(row) : null;
  } catch {
    return null;
  }
}

/** Página do catálogo, mais recentes primeiro. */export function listarOfertas(f: FiltroCatalogo = {}): PaginaCatalogo {
  const db = banco();
  const porPagina = Math.min(MAX_POR_PAGINA, Math.max(1, Math.floor(f.porPagina ?? 100)));
  const pagina = Math.max(1, Math.floor(f.pagina ?? 1));
  if (!db) return { total: 0, pagina, porPagina, itens: [] };
  const w = onde(f);
  try {
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ofertas ${w.sql}`).get(...w.params) as { n: number }).n
    );
    const rows = db
      .prepare(
        `SELECT * FROM ofertas ${w.sql} ORDER BY recebida_em DESC LIMIT ? OFFSET ?`
      )
      .all(...w.params, porPagina, (pagina - 1) * porPagina) as Record<string, unknown>[];
    return { total, pagina, porPagina, itens: rows.map(mapear) };
  } catch {
    return { total: 0, pagina, porPagina, itens: [] };
  }
}

/** Cards do painel: total e quebra por desfecho / programa / origem. */
export function resumoCatalogo(f: FiltroCatalogo = {}): ResumoCatalogo {
  const db = banco();
  const vazio: ResumoCatalogo = { total: 0, porDesfecho: {}, porPrograma: {}, porOrigem: {} };
  if (!db) return vazio;
  const w = onde(f);
  try {
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ofertas ${w.sql}`).get(...w.params) as { n: number }).n
    );
    const agrupar = (col: string): Record<string, number> => {
      const rows = db
        .prepare(`SELECT COALESCE(${col}, '(vazio)') AS k, COUNT(*) AS n FROM ofertas ${w.sql} GROUP BY k ORDER BY n DESC`)
        .all(...w.params) as { k: string; n: number }[];
      return Object.fromEntries(rows.map((r) => [String(r.k), Number(r.n)]));
    };
    return {
      total,
      porDesfecho: agrupar("desfecho"),
      porPrograma: agrupar("programa"),
      porOrigem: agrupar("origem"),
    };
  } catch {
    return vazio;
  }
}

/** CSV do catálogo (mesmo padrão do rastreio: `;`, aspas, anti-injeção). */
export function catalogoCsv(f: FiltroCatalogo = {}): string {
  const db = banco();
  const cab = [
    "data", "origem", "programa", "id", "titulo", "preco", "preco_de",
    "link", "cupom", "desfecho", "motivo",
  ];
  // Anti formula/CSV injection: campos que começam com = + - @ TAB CR recebem
  // apóstrofo para o Excel/LibreOffice não executarem nada.
  const esc = (v: unknown) => {
    let t = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  if (!db) return cab.join(";");
  const w = onde(f);
  const linhas: string[] = [cab.join(";")];
  try {
    const rows = db
      .prepare(`SELECT * FROM ofertas ${w.sql} ORDER BY recebida_em DESC`)
      .all(...w.params) as Record<string, unknown>[];
    for (const row of rows) {
      const o = mapear(row);
      linhas.push(
        [
          esc(new Date(o.recebidaEm).toLocaleString("pt-BR")),
          esc(o.origem),
          esc(o.programa),
          esc(o.idProduto ?? o.id),
          esc(o.titulo),
          esc(o.preco ?? ""),
          esc(o.precoDe ?? ""),
          esc(o.link),
          esc(o.cupom),
          esc(o.desfecho),
          esc(o.motivo),
        ].join(";")
      );
    }
  } catch {
    /* devolve só o cabeçalho */
  }
  return linhas.join("\n");
}

/** Retenção: apaga ofertas mais antigas que `dias`. Devolve quantas saíram. */
export function podarCatalogo(dias: number): number {
  const db = banco();
  if (!db || !Number.isFinite(dias) || dias <= 0) return 0;
  try {
    const corte = new Date(Date.now() - dias * 86_400_000).toISOString();
    const r = db.prepare("DELETE FROM ofertas WHERE recebida_em < ?").run(corte);
    return Number(r.changes ?? 0);
  } catch {
    return 0;
  }
}

/** Apaga o catálogo inteiro (operação explícita do operador). */
export function limparCatalogo(): number {
  const db = banco();
  if (!db) return 0;
  try {
    return Number(db.prepare("DELETE FROM ofertas").run().changes ?? 0);
  } catch {
    return 0;
  }
}

/** Retenção do catálogo em dias (CATALOGO_RETENCAO_DIAS, default 365). */
export function retencaoCatalogoDias(): number {
  const n = Number(process.env.CATALOGO_RETENCAO_DIAS ?? 365);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 365;
}
