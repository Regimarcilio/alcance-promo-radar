import type { Candidato, Oportunidade } from "./hunter/schema.js";

export interface Pesos { desconto: number; cupom: number; vendidos: number; avaliacao: number }
export const PESOS: Pesos = { desconto: 0.6, cupom: 0.15, vendidos: 0.15, avaliacao: 0.1 };

export function descontoPct(c: Candidato): number {
  if (!c.precoDe || c.precoDe <= c.precoAtual) return 0;
  return Math.round(((c.precoDe - c.precoAtual) / c.precoDe) * 100);
}

/** Score 0-100 explicável (RN-008). */
export function score(c: Candidato, temHistorico = true): { score: number; motivo: string; selo: "QUEDA REAL" | "OFERTA BOA" } {
  const d = descontoPct(c);
  const sCupom = c.cupom ? 100 : 0;
  const sVend = Math.min(100, Math.round((c.vendidos / 1000) * 100));
  const sAval = Math.round((c.avaliacao / 5) * 100);
  const score = Math.round(d * PESOS.desconto + sCupom * PESOS.cupom + sVend * PESOS.vendidos + sAval * PESOS.avaliacao);
  const partes = [`-${d}%`, c.cupom ? `cupom ${c.cupom}` : "sem cupom", `${c.vendidos} vendidos`, `${c.avaliacao.toFixed(1)}★`];
  const selo = temHistorico && d >= 20 ? "QUEDA REAL" : "OFERTA BOA";
  return { score, motivo: partes.join(" + "), selo };
}

export function rankear(candidatos: Candidato[], corte = 0, descontoMin = 30): Oportunidade[] {
  return candidatos
    .map((c) => {
      const d = descontoPct(c);
      const { score: s, motivo, selo } = score(c);
      return { ...c, descontoPct: d, score: s, motivo, selo };
    })
    .filter((o) => o.descontoPct >= descontoMin && o.score >= corte)
    .sort((a, b) => b.score - a.score);
}
