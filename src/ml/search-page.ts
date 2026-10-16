/**
 * Hunt via página de busca (quando a rede permite; search API é 403 aqui).
 * Tenta extrair o JSON embutido (__PRELOADED_STATE__) e varre resultados
 * {id MLB, title, price, thumbnail, permalink}. Qualquer falha → [].
 */
import type { Candidato } from "../hunter/schema.js";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

interface RawItem {
  id?: string;
  title?: string;
  price?: number | { amount?: number };
  original_price?: number;
  thumbnail?: string;
  permalink?: string;
  sold_quantity?: number;
}

function* varrer(node: unknown): Generator<RawItem> {
  if (Array.isArray(node)) {
    for (const v of node) yield* varrer(v);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.id === "string" && /^MLB-?\d+/.test(o.id) && typeof o.title === "string") {
      yield o as unknown as RawItem;
    }
    for (const v of Object.values(o)) yield* varrer(v);
  }
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && v > 0) return v;
  if (v && typeof v === "object" && typeof (v as any).amount === "number") return (v as any).amount;
  return null;
};

export async function huntPaginaBusca(query: string, limite = 50): Promise<Candidato[]> {
  try {
    const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(query).replace(/%20/g, "-")}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const html = await res.text();
    if (html.includes("account-verification") || !html.includes("__PRELOADED_STATE__")) return [];
    const m = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{.*?\});?\s*<\/script>/s);
    if (!m) return [];
    const state = JSON.parse(m[1]);
    const vistos = new Set<string>();
    const out: Candidato[] = [];
    for (const r of varrer(state)) {
      const id = (r.id as string).replace("MLB", "MLB-").replace("MLB--", "MLB-");
      if (vistos.has(id) || out.length >= limite) continue;
      const preco = num(r.price);
      if (!preco) continue;
      vistos.add(id);
      out.push({
        mlbId: id,
        titulo: r.title as string,
        imagem: r.thumbnail ?? "",
        precoDe: typeof r.original_price === "number" ? r.original_price : null,
        precoAtual: preco,
        cupom: null,
        vendidos: r.sold_quantity ?? 0,
        avaliacao: 0,
        link: r.permalink ?? `https://produto.mercadolivre.com.br/${id}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}
