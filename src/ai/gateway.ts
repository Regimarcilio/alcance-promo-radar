import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Oportunidade } from "../hunter/schema.js";
import { dataDirAtual } from "../config/paths.js";

export interface Trace { data: string; modelo: string; ms: number; custoBRL: number; mlbId: string; score: number }

/**
 * Gateway EngAI (ADR-002) — MVP local determinístico, sem custo.
 * Gera headline a partir do título (nunca muta números/link/cupom — RN-005)
 * e registra trace.json para auditoria de custo/latência.
 * Modelos pagos entram aqui depois, atrás da mesma interface.
 */
const HEADLINES = [
  (m: string) => `${m} — QUALIDADE ABSURDA`,
  (m: string) => `ACHADINHO: ${m} BARATO DEMAIS`,
  (m: string) => `${m} COM DESCONTO INSANO`,
];

export function gerarHeadline(o: Oportunidade, variacao = 0): { headline: string; subtitulo: string; trace: Trace } {
  const t0 = Date.now();
  const marca = o.titulo.split(" ").slice(0, 3).join(" ").toUpperCase() || "OFERTA";
  const headline = HEADLINES[variacao % HEADLINES.length](marca);
  const subtitulo = o.selo === "QUEDA REAL" ? "caiu muito o preço" : "oferta boa demais";
  const trace: Trace = {
    data: new Date().toISOString(),
    modelo: "template-local-v1",
    ms: Date.now() - t0,
    custoBRL: 0,
    mlbId: o.mlbId,
    score: o.score,
  };
  mkdirSync(dataDirAtual(), { recursive: true, mode: 0o700 });
  appendFileSync(join(dataDirAtual(), "trace.json"), JSON.stringify(trace) + "\n", { mode: 0o600 });
  return { headline, subtitulo, trace };
}
