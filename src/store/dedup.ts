/**
 * DEDUP do Monitor — anti-duplicidade de 7 dias (RN-010).
 *
 * A estrutura de armazenamento (retenção, limite e escrita atômica) foi
 * **generalizada** em `src/messaging/idempotencia.ts` (usada também pela
 * idempotência da Mensageria). A API pública deste módulo **não muda**:
 * `hashEnvio`, `jaEnviado` e `registrarEnvio` seguem iguais, e o arquivo
 * `data/envios.json` mantém o mesmo formato (`{hash, data, dia}`) — o
 * histórico de 7 dias é preservado.
 */
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { criarRegistro } from "../messaging/idempotencia.js";

/** Caminho resolvido em tempo de chamada (teste/smoke trocam ALCANCE_DATA_DIR). */
function arquivo(): string {
  return join(dataDirAtual(), "envios.json");
}

/** Registro de envios (7 dias, formato antigo preservado). */
function registro() {
  return criarRegistro({
    arquivo: arquivo(),
    retencaoDias: 7,
    limite: 50_000,
    campoChave: "hash",
  });
}

export function hashEnvio(mlbId: string, preco: number, cupom?: string | null): string {
  return `${mlbId}|${preco}|${(cupom ?? "").toUpperCase()}`;
}

/** Dia local (America/Sao_Paulo) em YYYY-MM-DD — o limite diário e o
 *  dedup usam o dia DE QUEM OPERA, nunca UTC (bug que pausava à toa). */
export function diaLocal(d: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** Anti-duplicidade 7 dias (RN-010). Retorna true se já enviado. */
export function jaEnviado(mlbId: string, preco: number, cupom?: string | null, dias = 7): boolean {
  return registro().tem(hashEnvio(mlbId, preco, cupom), dias);
}

export function registrarEnvio(mlbId: string, preco: number, cupom?: string | null, dias = 7): void {
  registro().registrar(hashEnvio(mlbId, preco, cupom), { dia: diaLocal() }, dias);
}
