/**
 * BACKUP do banco do Alcance (ADR-012, Fase 4).
 *
 * Por que não é `cp data/alcance.db`: com WAL ligado, copiar o `.db` sem os
 * `-wal`/`-shm` pode gerar um arquivo que abre **sem as últimas transações** (ou
 * corrompido). `VACUUM INTO` escreve um banco NOVO e consistente, num passo só.
 *
 * Política:
 * - um backup por dia (`BACKUP_BD_HORAS`, default 24; `0` desliga);
 * - guarda os `BACKUP_BD_MANTER` mais recentes (default 7, mínimo 1);
 * - tudo em `data/backups/`, que já é o bind mount versionado fora do git.
 *
 * Nunca lança: backup é acessório — se falhar, o painel segue no ar e o motivo
 * fica no log.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { banco } from "./db.js";

const HORAS_PADRAO = 24;
const MANTER_PADRAO = 7;

function dir(): string {
  return join(dataDirAtual(), "backups");
}

/** Intervalo mínimo entre backups (`BACKUP_BD_HORAS`; 0 desliga). */
export function horasBackup(): number {
  const n = Number(process.env.BACKUP_BD_HORAS ?? HORAS_PADRAO);
  if (!Number.isFinite(n) || n < 0) return HORAS_PADRAO;
  return n; // 0 = desligado (aceito de propósito)
}

/** Quantos backups manter (`BACKUP_BD_MANTER`, default 7, mínimo 1). */
export function manterBackups(): number {
  const n = Number(process.env.BACKUP_BD_MANTER ?? MANTER_PADRAO);
  const v = Number.isFinite(n) ? Math.floor(n) : MANTER_PADRAO;
  return Math.max(1, v);
}

export interface InfoBackup {
  caminho: string;
  nome: string;
  bytes: number;
  em: string;
}

export interface ResultadoBackup {
  ok: boolean;
  backup?: InfoBackup;
  erro?: string;
}

/** Backups existentes, do mais novo para o mais antigo. */
export function listarBackups(): InfoBackup[] {
  try {
    if (!existsSync(dir())) return [];
    return readdirSync(dir())
      .filter((n) => /^alcance-.*\.db$/.test(n))
      .map((nome) => {
        const caminho = join(dir(), nome);
        const st = statSync(caminho);
        return { caminho, nome, bytes: st.size, em: st.mtime.toISOString() };
      })
      .sort((a, b) => b.em.localeCompare(a.em));
  } catch {
    return [];
  }
}

/** Cria um backup consistente agora (VACUUM INTO). */
export function backupBanco(): ResultadoBackup {
  const db = banco();
  if (!db) return { ok: false, erro: "banco indisponível" };
  try {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const nome = `alcance-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
    const caminho = join(d, nome);
    // Aspas simples no literal: o caminho pode ter espaço/apóstrofo (Windows).
    db.exec(`VACUUM INTO '${caminho.replace(/'/g, "''")}'`);
    const st = statSync(caminho);
    return { ok: true, backup: { caminho, nome, bytes: st.size, em: st.mtime.toISOString() } };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
}

/** Apaga os backups além do teto. Devolve quantos foram removidos. */
export function podarBackups(manter = manterBackups()): number {
  try {
    const todos = listarBackups();
    const sobra = todos.slice(Math.max(1, manter));
    for (const b of sobra) {
      try {
        unlinkSync(b.caminho);
      } catch {
        /* segue: um arquivo travado não impede os outros */
      }
    }
    return sobra.length;
  } catch {
    return 0;
  }
}

/** Se já passou o intervalo desde o último backup. */
export function backupDevido(horas = horasBackup(), agora = Date.now()): boolean {
  if (horas <= 0) return false;
  const ultimo = listarBackups()[0];
  if (!ultimo) return true;
  const idade = agora - new Date(ultimo.em).getTime();
  return !Number.isFinite(idade) || idade >= horas * 3_600_000;
}

/** Política completa: se devido, faz o backup e poda. */
export function backupSeDevido(): {
  feito: boolean;
  backup?: InfoBackup;
  podados: number;
  erro?: string;
} {
  if (!backupDevido()) return { feito: false, podados: 0 };
  const r = backupBanco();
  if (!r.ok) return { feito: false, podados: 0, erro: r.erro };
  const podados = podarBackups();
  return { feito: true, backup: r.backup, podados };
}
