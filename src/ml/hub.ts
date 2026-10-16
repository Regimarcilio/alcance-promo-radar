/**
 * HUB DE AFILIADOS — busca oficial de ofertas (título+preços+foto+comissão).
 * Descoberto via sniff do tráfego do portal (botão "Ganhos extras").
 * POST /affiliate-program/api/hub/search?is_affiliate=true&device=desktop
 * body {search, sort, filters, offset} + cookie de sessão.
 * Funciona desta rede (mesma família do createLink) — fonte nº 1 da caça.
 */
import type { Candidato } from "../hunter/schema.js";

const ENDPOINT =
  "https://www.mercadolivre.com.br/affiliate-program/api/hub/search?is_affiliate=true&device=desktop";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export interface HubItem {
  mlbId: string;
  titulo: string;
  imagem: string;
  precoDe: number | null;
  precoPix: number;
  desconto: string | null;
  comissao: string | null;
  vendidos: string | null;
  url: string;
}

function cookies(): string {
  const viaEnv = process.env.COOKIE_ML?.trim() || "";
  if (viaEnv && !viaEnv.startsWith("cole_o_cookie")) return viaEnv;
  return "";
}

function fotoDe(picId: string): string {
  return `https://http2.mlstatic.com/D_NQ_NP_${picId}-O.jpg`;
}

function canonicaDe(metadata: any): string {
  const frag: string = metadata?.url_fragments ?? "";
  const wid = frag.match(/wid=(MLB\d+)/)?.[1];
  const id: string = wid ?? metadata?.id ?? "";
  const num = id.replace(/^MLB-?/, "");
  return num ? `https://produto.mercadolivre.com.br/MLB-${num}` : "";
}

function precoDeComp(comps: any[]): { de: number | null; pix: number; desc: string | null } {
  const price = comps.find((c: any) => c.type === "price")?.price ?? {};
  const cur = Number(price.current_price?.value ?? 0);
  const prev = price.previous_price ? Number(price.previous_price.value) : null;
  const desc: string | null = price.discount_label?.text ?? null;
  return { de: prev && prev > cur ? prev : null, pix: cur, desc };
}

function textoDe(comps: any[], tipo: string): string | null {
  const c = comps.find((x: any) => x.type === tipo);
  return c?.title?.text ?? c?.text ?? null;
}

/**
 * Busca ofertas no hub. category = ID ML (top ou folha, ex. MLB3937).
 * q = palavra-chave opcional (vazio = categoria inteira).
 * offset = paginação (lotes frescos a cada chamada).
 */
export async function hubSearch(opts: {
  category?: string;
  q?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}): Promise<HubItem[]> {
  const cookie = cookies();
  if (!cookie) throw new Error("SEM_COOKIE");
  const filters: any[] = [{ id: "extra_commission", value: true }];
  if (opts.category) filters.push({ id: "category", value: opts.category });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        origin: "https://www.mercadolivre.com.br",
        referer: "https://www.mercadolivre.com.br/afiliados/hub",
        "user-agent": UA,
        cookie,
      },
      body: JSON.stringify({
        search: opts.q ?? "",
        sort: opts.sort ?? "relevance",
        filters,
        offset: opts.offset ?? 0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HUB_${res.status}`);
    const json: any = await res.json();
    const cards: any[] = json.polycard_client_model?.polycards ?? [];
    const out: HubItem[] = [];
    for (const c of cards) {
      const md = c.metadata ?? {};
      const comps = c.components ?? [];
      const { de, pix, desc } = precoDeComp(comps);
      if (!pix) continue;
      const picId = c.pictures?.pictures?.[0]?.id;
      const chip = comps.find((x: any) => x.type === "chip");
      const comissao: string | null = chip
        ? `${chip.pill?.values?.map((v: any) => v.label?.text ?? "").join(" ") ?? ""}`.trim() || null
        : null;
      const review = comps.find((x: any) => x.type === "review_compacted");
      out.push({
        mlbId: String(md.id ?? "").replace("MLB", "MLB-").replace("MLB--", "MLB-"),
        titulo: textoDe(comps, "title") ?? String(md.id ?? ""),
        imagem: picId ? fotoDe(picId) : "",
        precoDe: de,
        precoPix: pix,
        desconto: desc,
        comissao,
        vendidos: review?.alt_text ?? null,
        url: canonicaDe(md),
      });
      if (out.length >= (opts.limit ?? 50)) break;
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

export function paraCandidato(h: HubItem): Candidato {
  return {
    mlbId: h.mlbId,
    titulo: h.titulo,
    imagem: h.imagem,
    precoDe: h.precoDe,
    precoAtual: h.precoPix,
    cupom: null,
    vendidos: 0,
    avaliacao: 0,
    link: h.url,
  };
}

export interface Subcategoria {
  id: string;
  name: string;
}

const cacheSub = new Map<string, { em: number; items: Subcategoria[] }>();

/**
 * Subcategorias disponíveis numa categoria — o próprio hub informa
 * (filtro "category" da resposta). Ex.: Beleza → Perfumes, Pele, Cabelo…
 */
export async function subcategoriasDe(categoryId: string): Promise<Subcategoria[]> {
  const hit = cacheSub.get(categoryId);
  if (hit && Date.now() - hit.em < 3600000) return hit.items;
  const cookie = cookies();
  if (!cookie) throw new Error("SEM_COOKIE");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        origin: "https://www.mercadolivre.com.br",
        referer: "https://www.mercadolivre.com.br/afiliados/hub",
        "user-agent": UA,
        cookie,
      },
      body: JSON.stringify({
        search: "",
        sort: "relevance",
        filters: [
          { id: "extra_commission", value: true },
          { id: "category", value: categoryId },
        ],
        offset: 0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HUB_${res.status}`);
    const json: any = await res.json();
    const cat = (json.filters ?? []).find((f: any) => f.id === "category");
    const items: Subcategoria[] = (cat?.values ?? [])
      .filter((v: any) => v.id && v.id !== categoryId)
      .map((v: any) => ({ id: String(v.id), name: String(v.name ?? v.id) }));
    cacheSub.set(categoryId, { em: Date.now(), items });
    return items;
  } finally {
    clearTimeout(t);
  }
}
