import type { Candidato, Filtros } from "./schema.js";
import { buildSearchUrl } from "./schema.js";
import { huntPaginaBusca } from "../ml/search-page.js";
import { completarCandidato } from "../ml/item-page.js";
import { hubSearch, paraCandidato } from "../ml/hub.js";
import catsJson from "../categorias.json" with { type: "json" };

const CATS = catsJson as { id: string; name: string }[];

/**
 * Hunter em 4 níveis (todos honestos sobre a fonte):
 * 0. HUB DE AFILIADOS (oficial, com comissão extra) — busca por categoria
 *    e palavra-chave; offset aleatório = lotes frescos;
 * 1. API pública de search (ideal, 403 nesta rede);
 * 2. Página de busca com q ou nome da categoria (q vazio = categoria);
 * 3. MOCK do piloto (badged como DEMO na UI).
 * Top N passam por enrich da página do produto quando há link real.
 */
export async function hunt(f: Filtros): Promise<{ url: string; candidatos: Candidato[]; mock: boolean }> {
  const url = buildSearchUrl(f.category, f.q);
  const efetiva = f.sub?.trim() || f.category; // subcategoria (folha) afunila a busca
  // 0) Hub: fonte real com comissão — tenta primeiro (offset = virar páginas)
  try {
    const hub = await hubSearch({ category: efetiva, q: f.q.trim() || undefined, offset: f.offset ?? 0, sort: (f as any).sort ?? "relevance" });
    if (hub.length > 0) {
      return { url: `hub:${efetiva}${f.q ? `+${f.q}` : ""}#${f.offset ?? 0}`, candidatos: hub.map(paraCandidato), mock: false };
    }
  } catch {
    /* cai para os níveis abaixo */
  }
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`ML search ${res.status}`);
    const json: any = await res.json();
    const items: any[] = json.results ?? [];
    const candidatos: Candidato[] = items.slice(0, 50).map((it: any, i: number) => ({
      mlbId: String(it.id ?? `MOCK-${i}`),
      titulo: String(it.title ?? "Sem título"),
      imagem: String(it.thumbnail ?? ""),
      precoDe: typeof it.original_price === "number" ? it.original_price : null,
      precoAtual: Number(it.price ?? 0),
      cupom: null,
      vendidos: Number(it.sold_quantity ?? 0),
      avaliacao: 0,
      link: `https://produto.mercadolivre.com.br/${it.id ?? ""}`,
    }));
    return { url, candidatos: await enrichTop(candidatos), mock: false };
  } catch {
    const catName = CATS.find((c) => c.id === f.category)?.name ?? "";
    const pagina = await huntPaginaBusca(f.q.trim() || catName);
    if (pagina.length > 0) {
      return { url: `${url} (+pagina:${f.q.trim() || catName})`, candidatos: await enrichTop(pagina), mock: false };
    }
    return { url, candidatos: mockPorCategoria(f), mock: true };
  }
}

/** Enriquece só o Top 8 (evita martelar o ML). */
async function enrichTop(cs: Candidato[]): Promise<Candidato[]> {
  const out: Candidato[] = [];
  for (const c of cs.slice(0, 8)) {
    if (/^https?:\/\//.test(c.link) && !c.link.includes("meli.la/mock")) {
      out.push(await completarCandidato(c));
    } else {
      out.push(c);
    }
  }
  return [...out, ...cs.slice(8)];
}

function mockPorCategoria(f: Filtros): Candidato[] {
  const q = f.q.trim() || "Oferta";
  const base: Candidato[] = [
    {
      mlbId: "MLB-4210056475",
      titulo: "Relógio de pulso Orient MBSS1171",
      imagem: "",
      precoDe: 459.99, precoAtual: 233.53, cupom: "OFERTADEHOJE",
      vendidos: 1200, avaliacao: 4.8,
      link: "https://meli.la/2aKpCmQ",
    },
    {
      mlbId: "MLB-1111111111",
      titulo: `${q} — Top 2 em ${f.category}`,
      imagem: "", precoDe: 399, precoAtual: 249,
      cupom: "TOP10", vendidos: 800, avaliacao: 4.6,
      link: "https://meli.la/mock2",
    },
    {
      mlbId: "MLB-2222222222",
      titulo: `${q} — Top 3 em ${f.category}`,
      imagem: "", precoDe: 299, precoAtual: 199,
      cupom: null, vendidos: 300, avaliacao: 4.2,
      link: "https://meli.la/mock3",
    },
  ];
  return base.filter((c) => c.precoAtual <= f.teto);
}
