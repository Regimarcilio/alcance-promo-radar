/**
 * Parser de ofertas em texto livre (E6 / RF-031 / RN-008 / RN-009).
 * Detecta URLs, classifica o programa de afiliado por allowlist de domínios
 * e extrai o id do produto quando possível.
 */
export type Programa = "mercadolivre" | "shopee" | "kabum" | "amazon" | "desconhecido";

export interface LinkDetectado {
  url: string;
  host: string;
  programa: Programa;
  idProduto: string | null; // MLB id / ASIN / id genérico
}

export interface OfertaDetectada {
  links: LinkDetectado[];
  principal: LinkDetectado | null; // 1º link de programa reconhecido (RN-009)
  textoLimpo: string; // texto sem o link principal (para reuso no template)
}

/** Allowlist de domínios por programa (RN-008). */
const DOMINIOS: { programa: Programa; hosts: string[] }[] = [
  { programa: "mercadolivre", hosts: ["mercadolivre.com.br", "meli.la", "mercadolibre.com"] },
  { programa: "shopee", hosts: ["shopee.com.br", "shope.ee", "s.shopee.com.br"] },
  { programa: "kabum", hosts: ["kabum.com.br", "kabum.com"] },
  { programa: "amazon", hosts: ["amazon.com.br", "amzn.to", "amzn.com.br"] },
];

const RE_URL = /https?:\/\/[^\s<>"')\]]+/gi;

function hostDe(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function pertence(host: string, dominio: string): boolean {
  return host === dominio || host.endsWith(`.${dominio}`);
}

export function classificar(url: string): { programa: Programa; host: string } {
  const host = hostDe(url);
  for (const grupo of DOMINIOS) {
    if (grupo.hosts.some((d) => pertence(host, d))) return { programa: grupo.programa, host };
  }
  return { programa: "desconhecido", host };
}

/** Extrai o id do produto conforme o programa. */
export function extrairId(url: string, programa: Programa): string | null {
  try {
    const u = new URL(url);
    if (programa === "mercadolivre") {
      // https://produto.mercadolivre.com.br/MLB-123456789-...  ou ?item=MLB123
      const m = (u.pathname + u.search).match(/MLB-?(\d{6,})/i);
      if (m) return `MLB${m[1]}`;
      const item = u.searchParams.get("item");
      if (item) return item.toUpperCase();
      return null;
    }
    if (programa === "amazon") {
      // /dp/ASIN ou /gp/product/ASIN
      const m = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      return m ? m[1].toUpperCase() : null;
    }
    if (programa === "shopee") {
      // -i.<shopid>.<itemid> ou /product/<shopid>/<itemid>
      const m = u.pathname.match(/-i\.(\d+)\.(\d+)/) || u.pathname.match(/\/product\/(\d+)\/(\d+)/);
      return m ? `${m[1]}.${m[2]}` : null;
    }
    if (programa === "kabum") {
      // /produto/<slug>-<codigo>  → pega sufixo numérico/alnum final
      const m = u.pathname.match(/\/produto\/([^/]+)/i);
      if (!m) return null;
      const cod = m[1].match(/([a-z0-9]{4,})$/i);
      return cod ? cod[1].toUpperCase() : m[1];
    }
  } catch {
    return null;
  }
  return null;
}

/** Remove uma URL do texto e descarta as linhas "decorativas" (só emoji,
 *  seta, pontuação) — evita deixar um "👉" órfão no lugar do link antigo.
 *  Exportado para reuso quando o link só é removido depois da expansão (curtos.ts). */
export function limparTexto(texto: string, remover: string): string {
  return texto
    .replace(remover, "")
    .split("\n")
    .filter((l) => l.trim() === "" || /[\p{L}\p{N}]/u.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Varre o texto e retorna todos os links + o principal reconhecido. */
export function detectar(texto: string): OfertaDetectada {
  const urls = [...texto.matchAll(RE_URL)].map((m) => m[0].replace(/[.,;!?]+$/, ""));
  const links: LinkDetectado[] = urls.map((url) => {
    const { programa, host } = classificar(url);
    return { url, host, programa, idProduto: extrairId(url, programa) };
  });
  const principal = links.find((l) => l.programa !== "desconhecido") ?? null;
  const textoLimpo = principal ? limparTexto(texto, principal.url) : texto;
  return { links, principal, textoLimpo };
}

/** Rótulo amigável do programa (para log / mensagem). */
export function rotulo(programa: Programa): string {
  return (
    { mercadolivre: "Mercado Livre", shopee: "Shopee", kabum: "KaBuM", amazon: "Amazon", desconhecido: "Desconhecido" }[
      programa
    ] ?? programa
  );
}
