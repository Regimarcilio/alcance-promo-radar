/**
 * Transformador de link de afiliado (E6 / RF-032 / RN-012).
 * Troca o link original pelo link de afiliado do usuário.
 * - Mercado Livre: reusa converterLink (provider.ts) com TAG/COOKIE já configurados.
 * - Shopee/KaBuM/Amazon: aplica parâmetro de rastreio quando configurado; senão mantém
 *   o link (marcando NAO_TRANSFORMADO para revisão, nunca inventa link).
 */
import { converterLink } from "../ml/provider.js";
import type { LinkDetectado } from "./parser.js";

export interface ResultadoTransformacao {
  url: string;
  ok: boolean; // true = link de afiliado do usuário aplicado
  motivo?: string; // quando ok=false
}

function comParam(url: string, chave: string, valor: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(chave, valor);
    return u.toString();
  } catch {
    return url;
  }
}

/** Mercado Livre: geração direta com tag+cookie (fonte única de verdade já testada). */
async function transformarML(link: LinkDetectado, conta?: string): Promise<ResultadoTransformacao> {
  const r = await converterLink(link.url, { conta });
  if (r.fonte === "conversor" && /^https?:\/\//.test(r.linkAfiliado) && r.linkAfiliado !== link.url) {
    return { url: r.linkAfiliado, ok: true };
  }
  return {
    url: link.url,
    ok: false,
    motivo: r.aviso ?? "COOKIE_OU_CONVERSOR_FALHOU — link ML não transformado",
  };
}

export async function transformar(
  link: LinkDetectado,
  opts: { conta?: string } = {}
): Promise<ResultadoTransformacao> {
  switch (link.programa) {
    case "mercadolivre":
      return transformarML(link, opts.conta);

    case "amazon": {
      // Rastreio Amazon via tag de associado (AMAZON_TAG no .env).
      const tag = process.env.AMAZON_TAG?.trim();
      if (tag) return { url: comParam(link.url, "tag", tag), ok: true };
      return { url: link.url, ok: false, motivo: "AMAZON_TAG não configurado" };
    }

    case "shopee": {
      // Shopee usa link próprio do painel de afiliado; sem geração automática confiável.
      // Aplica sub_id de rastreio se configurado, senão marca para revisão.
      const sub = process.env.SHOPEE_SUBID?.trim();
      if (sub) return { url: comParam(link.url, "smtt", sub), ok: true };
      return { url: link.url, ok: false, motivo: "SHOPEE_SUBID não configurado — revisar manualmente" };
    }

    case "kabum": {
      // KaBuM: parâmetro de tracking genérico quando configurado.
      const ref = process.env.KABUM_REF?.trim();
      if (ref) return { url: comParam(link.url, "utm_source", ref), ok: true };
      return { url: link.url, ok: false, motivo: "KABUM_REF não configurado — revisar manualmente" };
    }

    default:
      return { url: link.url, ok: false, motivo: "Programa não reconhecido" };
  }
}
