/**
 * Enrich de item via página do produto (sem API oficial).
 * Funciona quando a rede/IP não está atrás da verificação do ML;
 * qualquer falha → null (chamador usa fallback).
 */
import type { Candidato } from "../hunter/schema.js";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface ItemReal {
  titulo: string;
  imagem: string;
  precoAtual: number;
  precoDe: number | null;
  vendidos: number;
  link: string;
}

function meta(html: string, prop: string): string | null {
  const m = html.match(
    new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]+)"`, "i")
  );
  return m ? m[1] : null;
}

/** Extrai MLB-ID de URL ou texto ("MLB-4210056475" ou "MLB4210056475"). */
export function extrairMlbId(texto: string): string | null {
  const m = texto.toUpperCase().replace(/[.\s]/g, "").match(/MLB-?(\d{6,})/);
  return m ? `MLB-${m[1]}` : null;
}

const HOSTS_PERMITIDOS = ["mercadolivre.com.br", "mlstatic.com", "meli.la"];

/** SSRF: só busca produto nos domínios do ML (nunca intranet/localhost). */
export function hostPermitido(urlProduto: string): boolean {
  try {
    const h = new URL(urlProduto).hostname.toLowerCase();
    return HOSTS_PERMITIDOS.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

export async function enrichItem(urlProduto: string, timeoutMs = 20000): Promise<ItemReal | null> {
  if (!hostPermitido(urlProduto)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(urlProduto, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    if (html.includes("account-verification") || html.length < 50000) return null;
    const titulo = meta(html, "og:title");
    const imagem = meta(html, "og:image");
    const preco = meta(html, "product:price:amount");
    if (!titulo || !preco) return null;
    const orig = html.match(/"original_price":\s*([\d.]+)/);
    const sold = html.match(/"sold_quantity":\s*(\d+)/);
    return {
      titulo: titulo.replace(/\s+/g, " ").trim(),
      imagem: imagem ?? "",
      precoAtual: Number(preco),
      precoDe: orig ? Number(orig[1]) : null,
      vendidos: sold ? Number(sold[1]) : 0,
      link: meta(html, "og:url") ?? urlProduto,
    };
  } catch {
    return null;
  }
}

/** Título a partir do slug da própria URL (dado real, zero digitação). */
export function tituloDoSlug(urlProduto: string): string | null {
  const m =
    urlProduto.match(/\/([a-z0-9]+(?:-[a-z0-9]+)+)\/p\/MLB/i) ||
    urlProduto.match(/MLB-\d+-([a-z0-9-]+?)(_JM|[?/]|$)/i);
  if (!m) return null;
  const t = m[1].replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 4 ? t : null;
}

/** Completa um candidato com dados reais da página (mantém fallback). */
export async function completarCandidato(c: Candidato): Promise<Candidato> {
  if (!/^https?:\/\//.test(c.link)) return c;
  const slug = tituloDoSlug(c.link);
  const real = await enrichItem(c.link);
  if (!real) return slug && c.titulo === c.link ? { ...c, titulo: slug } : c;
  return {
    ...c,
    titulo: real.titulo,
    imagem: real.imagem || c.imagem,
    precoAtual: real.precoAtual,
    precoDe: real.precoDe ?? c.precoDe,
    vendidos: real.vendidos || c.vendidos,
    link: real.link,
  };
}
