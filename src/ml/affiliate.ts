/**
 * Link de afiliado DIRETO via endpoint interno do ML (sem intermediários).
 * Descoberto via Garimpei (open source) e provado aqui: 200 em ~0.5s.
 * POST /affiliate-program/api/v2/affiliates/createLink {urls, tag} + cookie
 * → {short_url (meli.la), tag ecoada, text (código de busca)}.
 */
const ENDPOINT =
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export interface LinkAfiliado {
  shortUrl: string;
  tagOk: boolean;
  searchCode: string | null;
  textoML: string | null;
  longUrl: string | null;
}

function creds(): { tag: string | null; cookie: string | null } {
  const tag = process.env.TAG_ML?.trim() || null;
  const cookie = process.env.COOKIE_ML?.trim() || null;
  return {
    tag: tag && tag !== "minhaetiqueta" ? tag : null,
    cookie: cookie && !cookie.startsWith("cole_o_cookie") ? cookie : null,
  };
}

export function temCredenciais(): boolean {
  const { tag, cookie } = creds();
  return !!(tag && cookie);
}

export interface Creds {
  tag: string;
  cookie: string;
}

export async function gerarLinkAfiliado(
  urlProduto: string,
  override?: Creds
): Promise<LinkAfiliado> {
  const { tag, cookie } = override ?? creds();
  if (!tag || !cookie) throw new Error("SEM_CREDENCIAIS (TAG_ML/COOKIE_ML)");
  // Normaliza para a forma canônica: o createLink rejeita (erro 111)
  // URLs /p/ com slug e links curtos — só produto/MLB-ID passa sempre.
  // Prioridade do ID: wid= (item real do deal) > item_id= > /p/MLB > 1º match.
  const upper = urlProduto.toUpperCase().replace(/[.\s]/g, "");
  const pick =
    upper.match(/WID=MLB(\d{6,})/)?.[1] ??
    upper.match(/ITEM_ID%3AMLB(\d{6,})/)?.[1] ??
    upper.match(/\/P\/MLB(\d{6,})/)?.[1] ??
    upper.match(/MLB-?(\d{6,})/)?.[1];
  const canonica =
    pick && /mercadolivre|meli\.la/i.test(urlProduto)
      ? `https://produto.mercadolivre.com.br/MLB-${pick}`
      : urlProduto;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        origin: "https://www.mercadolivre.com.br",
        referer: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
        "user-agent": UA,
        cookie,
      },
      body: JSON.stringify({ urls: [canonica], tag }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CREATELINK_${res.status}`);
    const json: any = await res.json();
    const item = json.urls?.[0];
    const shortUrl: string | undefined = item?.short_url;
    if (!shortUrl) {
      if (/not allowed/i.test(item?.message ?? "")) {
        throw new Error("PRODUTO_FORA_DO_PROGRAMA (ML não comissiona este anúncio)");
      }
      throw new Error("CREATELINK_SEM_URL");
    }
    const code = item.text?.match(/buscador[^:]*:\s*(\S+)/i)?.[1] ?? null;
    const longUrl: string | null = item.long_url ?? null;
    if (longUrl) {
      try {
        const { registrarFeed } = await import("./vitrine.js");
        registrarFeed(longUrl); // alimenta a vitrine (fonte real de produtos)
      } catch {
        /* vitrine opcional */
      }
    }
    return { shortUrl, tagOk: item.tag === tag, searchCode: code, textoML: item.text ?? null, longUrl };
  } finally {
    clearTimeout(t);
  }
}
