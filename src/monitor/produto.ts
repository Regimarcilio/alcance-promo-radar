/**
 * Resolve o link do anúncio ML (inclusive links CURTOS `meli.la/XXXX`) e extrai
 * dados reais da página (og:title / og:image + MLB id).
 *
 * Por que existe: as mensagens reais dos grupos usam link curto
 * (ex.: https://meli.la/2GQWuZ8), que NÃO contém o id do produto no texto.
 * Sem resolver o redirect, o createLink falha ("URL Invalid.") e a mensagem
 * cai em REVISAO. Resolvendo, achamos o MLB id (para o createLink) e a foto
 * do produto (para o template anterior).
 */
import { extrairMlbId, hostPermitido } from "../ml/item-page.js";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface DadosProduto {
  id: string | null; // MLB-<dígitos>
  titulo: string | null;
  imagem: string | null;
  urlFinal: string;
}

/**
 * Id do ANÚNCIO (não do catálogo). A página traz vários MLB-<id>: o de catálogo
 * (`/p/MLB…`, 11–12 dígitos) é rejeitado pelo createLink; o do anúncio está em
 * `"item_id":"MLB…"` / `"id":"MLB…"`. Preferir sempre este.
 */
function extrairItemId(html: string): string | null {
  const m =
    html.match(/"item_id"\s*:\s*"(MLB\d{6,})"/) ??
    html.match(/"id"\s*:\s*"(MLB\d{9,})"/);
  return m ? `MLB-${m[1].replace(/^MLB/, "")}` : null;
}

function meta(html: string, prop: string): string | null {
  const m = html.match(
    new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]+)"`, "i")
  );
  return m ? m[1] : null;
}

/** mlstatic entrega .webp; o WhatsApp lida melhor com o .jpg equivalente. */
function imagemCompativel(url: string | null): string | null {
  if (!url) return null;
  if (/mlstatic\.com/i.test(url) && /\.webp$/i.test(url)) {
    return url.replace(/\.webp$/i, ".jpg");
  }
  return url;
}

/** Segue o redirect (meli.la → página do anúncio) e lê as meta tags og:. */
export async function resolverProdutoML(
  url: string,
  timeoutMs = 20000
): Promise<DadosProduto | null> {
  if (!hostPermitido(url)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const id = extrairItemId(html) ?? extrairMlbId(res.url) ?? extrairMlbId(html);
    const titulo = meta(html, "og:title");
    const imagem = imagemCompativel(meta(html, "og:image"));
    if (!id && !titulo && !imagem) return null;
    return {
      id,
      titulo: titulo ? titulo.replace(/\s+/g, " ").trim() : null,
      imagem,
      urlFinal: res.url,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** "1.234,56" | "202,90" | "98" → number. */
function paraNumero(s: string): number {
  const limpo = s.replace(/\./g, "").replace(",", ".");
  const n = Number(limpo);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Extrai preços do texto da mensagem do hunter.
 * Prioriza rótulos ("De:" / "Por:"); senão usa maior=De, menor=Por.
 */
export function extrairPrecos(texto: string): {
  precoDe: number | null;
  precoAtual: number | null;
} {
  const val = (re: RegExp): number | null => {
    const m = texto.match(re);
    if (!m) return null;
    const n = paraNumero(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  let precoDe = val(
    /(?:de|era|antes)\s*:?\s*~?\*{0,2}\s*R\$\s*([\d.]+(?:,\d{2})?)/i
  );
  let precoAtual = val(
    /(?:por|agora|sai por|compre por)\s*:?\s*\*{0,2}\s*R\$\s*([\d.]+(?:,\d{2})?)/i
  );

  const todos = [...texto.matchAll(/R\$\s*([\d.]+(?:,\d{2})?)/gi)]
    .map((m) => paraNumero(m[1]))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (precoAtual == null && todos.length) {
    precoAtual = todos.length === 1 ? todos[0] : Math.min(...todos);
  }
  if (precoDe == null) {
    const maiores = todos.filter((v) => v !== precoAtual);
    if (maiores.length) precoDe = Math.max(...maiores);
  }
  // "De" nunca pode ser ≤ "Por".
  if (precoDe != null && precoAtual != null && precoDe <= precoAtual) precoDe = null;
  return { precoDe, precoAtual };
}
