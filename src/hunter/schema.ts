import { z } from "zod";

export const FiltrosSchema = z.object({
  category: z.string().min(3), // ex. MLB3937
  q: z.string().default(""), // palavra-chave opcional; vazio = toda categoria
  descontoMin: z.number().min(0).max(90).default(30),
  teto: z.number().positive().default(500),
  soComCupom: z.boolean().default(false),
  limite: z.number().int().min(1).max(50).default(10),
  sub: z.string().default(""), // subcategoria (folha ML, ex. MLB6284 Perfumes); vazio = categoria inteira
  offset: z.number().int().min(0).default(0), // paginação da caça (18 por página)
  sort: z.string().default("relevance"), // relevance | lowest_price | highest_price
});
export type Filtros = z.infer<typeof FiltrosSchema>;

export const CandidatoSchema = z.object({
  mlbId: z.string(),
  titulo: z.string(),
  imagem: z.string().url().or(z.string()),
  precoDe: z.number().nullable(),
  precoAtual: z.number(),
  cupom: z.string().nullable().default(null),
  vendidos: z.number().default(0),
  avaliacao: z.number().min(0).max(5).default(0),
  link: z.string(),
});
export type Candidato = z.infer<typeof CandidatoSchema>;

export const OportunidadeSchema = CandidatoSchema.extend({
  descontoPct: z.number(),
  score: z.number(),
  motivo: z.string(),
  selo: z.enum(["QUEDA REAL", "OFERTA BOA"]),
});
export type Oportunidade = z.infer<typeof OportunidadeSchema>;

/** URL oficial de busca: sem q = categoria inteira, com q = filtrada. */
export function buildSearchUrl(category: string, q: string, limit = 50): string {
  const base = `https://api.mercadolibre.com/sites/MLB/search?category=${category}&limit=${limit}&sort=sold_quantity_desc`;
  return q.trim() ? `${base}&q=${encodeURIComponent(q.trim())}` : base;
}
