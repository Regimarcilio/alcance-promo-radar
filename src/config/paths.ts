import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Diretório de estado. Resolvido em tempo de chamada (não no import) para que
 * testes/smoke possam trocar ALCANCE_DATA_DIR e reimportar o módulo.
 */
export function dataDirAtual(): string {
  return process.env.ALCANCE_DATA_DIR || join(root, "data");
}

/** Diretório de logs persistentes (fora do data/ para facilitar retenção). */
export function logsDirAtual(): string {
  return process.env.ALCANCE_LOGS_DIR || join(root, "logs");
}

/** Raiz do projeto (para localizar assets versionados em runtime). */
export const projectRoot = root;
