import { gerarLinkAfiliado } from "./affiliate.js";
import { resolver } from "./contas.js";

/**
 * Enrich real do link de afiliado (US-01 / ADR-003).
 * Ordem: 1) createLink DIRETO com TAG+COOKIE (provado: 200 ~0.5s, tag ecoada);
 * 2) conversor externo via ML_CONVERSOR_URL; 3) fallback com guia.
 */
export interface EnrichOut { linkAfiliado: string; fonte: "conversor" | "hunter-fallback"; aviso?: string }

export function credenciaisML(): { tag: string | null; cookie: string | null } {
  const tag = process.env.TAG_ML?.trim() || null;
  const cookie = process.env.COOKIE_ML?.trim() || null;
  return {
    tag: tag && tag !== "minhaetiqueta" ? tag : null,
    cookie: cookie && !cookie.startsWith("cole_o_cookie") ? cookie : null,
  };
}

/**
 * Converte URL do produto em link afiliado.
 * MVP: se houver conversor configurado via ML_CONVERSOR_URL (POST {url} -> {final_url}),
 * usa-o; senão retorna o link do hunter com aviso COOKIE_MISSING + guia.
 */
export async function converterLink(
  urlProduto: string,
  opts: { conta?: string; category?: string } = {}
): Promise<EnrichOut & { conta?: string }> {
  // 0) Qual conta? override > mapa da categoria > padrão > .env
  let creds: { nome: string; tag: string; cookie: string } | null = null;
  try {
    creds = resolver(opts.category, opts.conta);
  } catch {
    creds = null;
  }
  const tag = creds?.tag ?? credenciaisML().tag;
  const cookie = creds?.cookie ?? credenciaisML().cookie;
  // 1) Direto com as credenciais da conta resolvida (tag ecoada e validada).
  if (tag && cookie) {
    try {
      const r = await gerarLinkAfiliado(urlProduto, { tag, cookie });
      if (!r.tagOk) throw new Error("TAG_DIVERGENTE");
      return { linkAfiliado: r.shortUrl, fonte: "conversor", conta: creds?.nome };
    } catch (e: any) {
      // cai para o conversor externo / fallback abaixo
    }
  }
  // 2) Conversor externo (Bot do Afiliado e compatíveis).
  const conversor = process.env.ML_CONVERSOR_URL?.trim();
  if (conversor && tag && cookie) {
    try {
      const res = await fetch(`${conversor.replace(/\/$/, "")}/convert-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": process.env.ML_API_KEY ?? "", Cookie: cookie },
        body: JSON.stringify({ url: urlProduto, tag }),
      });
      if (!res.ok) throw new Error(`conversor ${res.status}`);
      const json: any = await res.json();
      const final = json.final_url ?? json.link ?? urlProduto;
      return { linkAfiliado: String(final), fonte: "conversor" };
    } catch (e: any) {
      return {
        linkAfiliado: urlProduto,
        fonte: "hunter-fallback",
        aviso: `COOKIE_OU_CONVERSOR_FALHOU (${e.message}). Atualize COOKIE_ML no .env (gerador de links ML → F12 → Network → createLink → Cookie) e crie ≥2 etiquetas reserva.`,
      };
    }
  }
  const faltando = [!tag ? "TAG_ML" : null, !cookie ? "COOKIE_ML" : null].filter(Boolean);
  return {
    linkAfiliado: urlProduto,
    fonte: "hunter-fallback",
    aviso:
      faltando.length > 0
        ? `CREDENCIAL_FALTANDO (${faltando.join("+")}) — usando link do hunter. Guia cookie: portal do afiliado ML → gerador de links → F12 → Network → createLink → copiar Cookie para o .env.`
        : "ML_CONVERSOR_URL não configurado — usando link do hunter.",
  };
}
