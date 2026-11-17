/**
 * Adapter de banco — SQLite embutido (`node:sqlite`).
 *
 * Por que existe: o estado do Alcance é JSON atômico, e o rastreio reescreve o
 * arquivo INTEIRO a cada oferta (177 ms / 1,85 MB medidos em 2026-11-16). O
 * catálogo de ofertas recebidas — que hoje não existe — precisa de escrita
 * incremental e consulta filtrada. ADR-012.
 *
 * Regras deste módulo:
 * - TODO acesso ao banco passa por aqui. Trocar de banco = reescrever este
 *   arquivo (o resto do código só conhece as funções de `catalogo.ts`).
 * - O caminho é resolvido em tempo de CHAMADA (`bancoPath()`), para que testes
 *   possam trocar `ALCANCE_DATA_DIR` e reimportar (mesmo contrato de paths.ts).
 * - Abrir nunca derruba o processo: se falhar, `banco()` devolve `null` e o
 *   chamador degrada. O catálogo é acessório; o Monitor não pode parar por ele.
 * - `CATALOGO_BD=0` desliga o banco por completo (útil em teste/smoke).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";

/** Versão do schema. Subir aqui quando mudar o DDL (migração explícita). */
export const VERSAO_SCHEMA = 1;

/** Depois de uma falha, não tenta reabrir por este tempo (evita erro por msg). */
const RETENTATIVA_MS = 60_000;

let conexao: DatabaseSync | null = null;
let proximaTentativa = 0;
let ultimoErro: string | null = null;
let versaoAplicada: number | null = null;

/** Caminho do arquivo do banco (dentro de `data/`, que já é bind mount). */
export function bancoPath(): string {
  return join(dataDirAtual(), "alcance.db");
}

/** `CATALOGO_BD=0` desliga o banco sem apagar nada. */
export function bancoHabilitado(): boolean {
  return process.env.CATALOGO_BD !== "0";
}

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ofertas (
  id          TEXT PRIMARY KEY,
  recebida_em TEXT NOT NULL,
  origem      TEXT NOT NULL,
  programa    TEXT,
  id_produto  TEXT,
  titulo      TEXT,
  preco       REAL,
  preco_de    REAL,
  link        TEXT,
  cupom       TEXT,
  imagem      TEXT,
  mensagem    TEXT,
  texto       TEXT,
  tem_midia   INTEGER NOT NULL DEFAULT 0,
  desfecho    TEXT NOT NULL,
  motivo      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ofertas_recebida ON ofertas(recebida_em DESC);
CREATE INDEX IF NOT EXISTS idx_ofertas_programa  ON ofertas(programa);
CREATE INDEX IF NOT EXISTS idx_ofertas_origem    ON ofertas(origem);
CREATE INDEX IF NOT EXISTS idx_ofertas_desfecho  ON ofertas(desfecho);
CREATE INDEX IF NOT EXISTS idx_ofertas_preco     ON ofertas(preco);
CREATE INDEX IF NOT EXISTS idx_ofertas_produto   ON ofertas(id_produto);
`;

function aplicarSchema(db: DatabaseSync): void {
  db.exec(DDL);
  const row = db
    .prepare("SELECT valor FROM schema_meta WHERE chave = 'versao'")
    .get() as { valor: string } | undefined;
  const atual = row ? Number(row.valor) : 0;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (chave, valor) VALUES ('versao', ?)").run(String(VERSAO_SCHEMA));
    versaoAplicada = VERSAO_SCHEMA;
    return;
  }
  // No futuro: if (atual < 2) { ALTER TABLE ...; UPDATE schema_meta ... }
  versaoAplicada = atual;
}

/**
 * Abre (ou reaproveita) a conexão. Devolve `null` se o banco estiver desligado
 * ou indisponível — nunca lança.
 */
export function banco(): DatabaseSync | null {
  if (!bancoHabilitado()) return null;
  if (conexao) return conexao;
  if (Date.now() < proximaTentativa) return null;
  try {
    mkdirSync(dataDirAtual(), { recursive: true });
    const db = new DatabaseSync(bancoPath());
    // WAL: leitor não bloqueia escritor. busy_timeout: scripts/smoke em paralelo
    // esperam em vez de estourar SQLITE_BUSY.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    aplicarSchema(db);
    conexao = db;
    ultimoErro = null;
    return db;
  } catch (e) {
    ultimoErro = e instanceof Error ? e.message : String(e);
    proximaTentativa = Date.now() + RETENTATIVA_MS;
    conexao = null;
    return null;
  }
}

/** Fecha a conexão (testes e desligamento limpo). */
export function fecharBanco(): void {
  if (conexao) {
    try {
      conexao.close();
    } catch {
      /* já fechado */
    }
  }
  conexao = null;
  proximaTentativa = 0;
}

export interface StatusBanco {
  habilitado: boolean;
  aberto: boolean;
  caminho: string;
  versao: number | null;
  erro: string | null;
}

/** Estado para `/healthz` e para o painel. Não abre conexão nova. */
export function statusBanco(): StatusBanco {
  return {
    habilitado: bancoHabilitado(),
    aberto: conexao !== null,
    caminho: bancoPath(),
    versao: versaoAplicada,
    erro: ultimoErro,
  };
}
