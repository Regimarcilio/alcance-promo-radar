/**
 * AMAZON no Piloto: categorias, link de afiliado e tag de rastreio.
 *
 * O modelo é o MESMO do Mercado Livre (categoria → caça → score → post com
 * link de afiliado), trocando só a fonte da caça:
 *   ML      → hunt()            (api.mercadolibre.com + hub de afiliados)
 *   Amazon  → buscarOfertasAmazon() (Creators API: searchItems)
 *
 * RASTREIO (tracking): a atribuição de venda na Amazon é feita pelo `tag`
 * (tracking ID do Associado). Como o painel tem várias categorias, cada
 * categoria pode usar um tracking ID próprio (AMAZON_TAG_AMXXX) para saber
 * no painel da Amazon qual categoria originou a venda. Sem tag específica,
 * usa a global (AMAZON_TAG).
 */
import catsJson from "./categorias.json" with { type: "json" };

export interface CategoriaAmazon {
  id: string;
  nome: string;
  keywords: string[];
}

export const CATEGORIAS_AMAZON = catsJson as CategoriaAmazon[];

export function categoriaAmazon(id: string): CategoriaAmazon | null {
  return CATEGORIAS_AMAZON.find((c) => c.id === id) ?? null;
}

/** Tag de rastreio: específica da categoria (AMAZON_TAG_AMXXX) ou global. */
export function tagAmazon(categoriaId?: string): string {
  if (categoriaId) {
    const env = process.env[`AMAZON_TAG_${categoriaId.toUpperCase()}`]?.trim();
    if (env) return env;
  }
  return process.env.AMAZON_TAG?.trim() ?? "";
}

/**
 * Link de afiliado Amazon. A tag é o que credita a comissão — sem ela o link
 * é só de vitrine (não paga nada).
 */
export function linkAfiliadoAmazon(asin: string, tag?: string): string {
  const a = String(asin ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a)) return "";
  const t = (tag ?? "").trim();
  const base = `https://www.amazon.com.br/dp/${a}`;
  return t ? `${base}?tag=${encodeURIComponent(t)}` : base;
}

/** Palavras de busca da categoria (rotaciona por giro para variar as ofertas). */
export function keywordsDaCategoria(categoriaId: string, giro = 0): string[] {
  const c = categoriaAmazon(categoriaId);
  if (!c) return [];
  const k = c.keywords.length ? c.keywords : [c.nome];
  return [k[Math.abs(giro) % k.length], ...k.filter((_, i) => i !== Math.abs(giro) % k.length)];
}
