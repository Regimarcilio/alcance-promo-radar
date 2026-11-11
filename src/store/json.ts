import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Persistência JSON atômica e com permissão restrita.
 * - tmp único (uuid) evita que duas gravações concorrentes se atropelem;
 * - mkdir 0700 + arquivo 0600 reduzem exposição de PII/credenciais;
 * - rename é atômico no mesmo filesystem.
 */
export function gravarJsonAtomico(arquivo: string, dados: unknown): void {
  const dir = dirname(arquivo);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* diretório pode ser de outro dono (bind mount) */
  }
  const tmp = `${arquivo}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(dados, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, arquivo);
}

/** Lê JSON; devolve `fallback` em arquivo ausente/corrompido. */
export function lerJson<T>(arquivo: string, fallback: T): T {
  try {
    if (!existsSync(arquivo)) return fallback;
    return JSON.parse(readFileSync(arquivo, "utf8")) as T;
  } catch {
    return fallback;
  }
}
