/**
 * Amazon Creators API (substituta da PA-API 5.0, descontinuada em 15/05/2026).
 *
 * Uso aqui: ENRIQUECER o repasse com título/foto oficiais do anúncio — o link
 * de afiliado continua sendo gerado pela troca de `tag` no transformer; a API
 * não gera link.
 *
 * Fluxo (docs: associados.amazon.com.br/creatorsapi/docs):
 *  1) OAuth 2.0 client_credentials — endpoint de token depende da "Version" da
 *     credencial (3.1 NA cobre o BR → api.amazon.com; 3.2 EU; 3.3 FE).
 *  2) POST https://creatorsapi.amazon/catalog/v1/getItems com x-marketplace.
 *
 * Pré-requisitos das credenciais (lado Amazon): >= 10 vendas qualificadas nos
 * últimos 30 dias + aceitação final no programa; gerar em Portal de Associados
 * → Ferramentas → Creators API (Credential ID + Secret).
 *
 * Sem AMAZON_CREATORS_ID/SECRET o módulo é INERTE (nenhuma chamada de rede):
 * o monitor mantém o comportamento anterior e nunca bloqueia o encaminhamento.
 */
const TOKEN_URLS: Record<string, string> = {
  "3.1": "https://api.amazon.com/auth/o2/token", // NA: US, CA, MX, BR
  "3.2": "https://api.amazon.co.uk/auth/o2/token", // EU
  "3.3": "https://api.amazon.co.jp/auth/o2/token", // FE
};
const API_BASE = "https://creatorsapi.amazon";

export interface DadosAmazonApi {
  asin: string;
  titulo: string | null;
  imagem: string | null;
  /** detailPageURL do item (já vem com a partnerTag aplicada) — referência/validação. */
  urlDetalhe: string | null;
}

let cacheToken: { token: string; expiraEm: number } | null = null;

/** Padrões do CDN de imagem principal do anúncio (slot 01 = foto principal). */
const IMAGEM_PADROES = ["01._SCLZZZZZZZ_SX500_.jpg", "01._SCLZZZZZZZ_.jpg"];

/**
 * Imagem principal do anúncio montada pelo padrão do CDN da Amazon.
 * Fallback enquanto a Creators API não está liberada (sem API, sem scrape).
 * Valida com HEAD antes de devolver: URL inexistente faria o sendMedia falhar.
 */
export async function resolverImagemAmazon(asin: string): Promise<string | null> {
  if (!/^[A-Z0-9]{10}$/i.test(asin)) return null;
  for (const sufixo of IMAGEM_PADROES) {
    const url = `https://m.media-amazon.com/images/P/${asin.toUpperCase()}.${sufixo}`;
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      if (r.ok) return url;
    } catch {
      // tenta o próximo padrão
    }
  }
  return null;
}

function marketplace(): string {
  return process.env.AMAZON_MARKETPLACE?.trim() || "www.amazon.com.br";
}

function tokenUrl(): string {
  const versao = process.env.AMAZON_CREATORS_VERSION?.trim() || "3.1";
  return TOKEN_URLS[versao] ?? TOKEN_URLS["3.1"];
}

/** Credenciais configuradas? (sem elas, nada neste módulo toca a rede) */
export function credenciaisAmazon(): { id: string; secret: string } | null {
  const id = process.env.AMAZON_CREATORS_ID?.trim();
  const secret = process.env.AMAZON_CREATORS_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

/** Somente para testes: zera o cache do token entre casos. */
export function limparCacheAmazon(): void {
  cacheToken = null;
}

async function obterToken(forcar = false): Promise<string | null> {
  const cred = credenciaisAmazon();
  if (!cred) return null;
  if (!forcar && cacheToken && Date.now() < cacheToken.expiraEm) return cacheToken.token;
  try {
    const r = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: cred.id,
        client_secret: cred.secret,
        scope: "creatorsapi::default",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: unknown; expires_in?: unknown };
    const token = typeof j.access_token === "string" ? j.access_token : "";
    if (!token) return null;
    const expires = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
    // renova 2 min antes de expirar; nunca abaixo de 60s de validade útil
    cacheToken = { token, expiraEm: Date.now() + Math.max(60, expires - 120) * 1000 };
    return token;
  } catch {
    return null;
  }
}

/**
 * Busca título/foto do anúncio pelo ASIN (GetItems).
 * Devolve null em qualquer falha (sem credencial, 401/403 não recuperável,
 * timeout, item inexistente) — quem chama decide o fallback.
 *
 * Preço NÃO é buscado aqui: o template usa `extrairPrecos(textoOriginal)` do
 * próprio post da origem (igual ao fluxo do Mercado Livre). Se um dia fizer
 * falta, dá para incluir "offersV2.listings.price" nos resources.
 */
export async function resolverProdutoAmazon(asin: string): Promise<DadosAmazonApi | null> {
  if (!credenciaisAmazon()) return null;
  if (!/^[A-Z0-9]{10}$/i.test(asin)) return null;

  const tag = process.env.AMAZON_TAG?.trim() ?? "";
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const token = await obterToken(tentativa > 0); // 2ª volta renova o token
    if (!token) return null;
    try {
      const r = await fetch(`${API_BASE}/catalog/v1/getItems`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-marketplace": marketplace(),
        },
        body: JSON.stringify({
          itemIds: [asin.toUpperCase()],
          itemIdType: "ASIN",
          marketplace: marketplace(),
          partnerTag: tag,
          resources: ["itemInfo.title", "images.primary.large", "images.primary.medium"],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 401 || r.status === 403) continue; // token expirado/inválido → renova na 2ª volta
      if (!r.ok) return null;
      const j = (await r.json()) as {
        itemsResult?: {
          items?: {
            asin?: unknown;
            detailPageURL?: unknown;
            images?: { primary?: { large?: { url?: unknown }; medium?: { url?: unknown } } };
            itemInfo?: { title?: { displayValue?: unknown } };
          }[];
        };
      };
      const item = j.itemsResult?.items?.[0];
      if (!item) return null;
      const titulo = item.itemInfo?.title?.displayValue;
      const imagem = item.images?.primary?.large?.url ?? item.images?.primary?.medium?.url;
      return {
        asin: typeof item.asin === "string" ? item.asin : asin.toUpperCase(),
        titulo: typeof titulo === "string" && titulo ? titulo : null,
        imagem: typeof imagem === "string" && imagem ? imagem : null,
        urlDetalhe: typeof item.detailPageURL === "string" ? item.detailPageURL : null,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * CAÇA DE OFERTAS AMAZON (SearchItems da Creators API).
 *
 * É a fonte do Piloto para Amazon: busca ofertas por palavra-chave (a categoria
 * do Alcance) e devolve no MESMO formato de Candidato do Mercado Livre, para o
 * scorer/formatador não mudarem.
 *
 * Sem credencial (AMAZON_CREATORS_ID/SECRET) devolve null — o loop do Piloto
 * então fica aguardando (nunca posta oferta inventada).
 */
export interface OfertaAmazon {
  asin: string;
  titulo: string;
  imagem: string | null;
  preco: number;
  precoDe: number | null; // preço "de" (base do desconto), quando a API devolve
  avaliacao: number;
  avaliacoes: number;
  vendasProxy: number; // proxy de "vendidos" (rank de vendas do browse node)
  link: string;
}

/** Recursos pedidos ao SearchItems (o mínimo para título, foto e preço). */
const RECURSOS_BUSCA = [
  "ItemInfo.Title.DisplayValue",
  "Images.Primary.Medium",
  "Offers.Listings.Price",
  "BrowseNodeInfo.BrowseNodes.SalesRank",
  "CustomerReviews.Count",
  "CustomerReviews.StarRating",
];

/** Lê a primeira chave existente entre variantes (a API muda de casing por versão). */
function pick(obj: any, ...caminhos: string[]): any {
  for (const c of caminhos) {
    const partes = c.split(".");
    let v: any = obj;
    for (const p of partes) {
      if (v == null) break;
      v = v[p];
    }
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export async function buscarOfertasAmazon(opts: {
  keywords: string;
  limite?: number;
  pagina?: number;
  sortBy?: string;
  tag?: string;
}): Promise<OfertaAmazon[] | null> {
  if (!credenciaisAmazon()) return null;
  const keywords = String(opts.keywords ?? "").trim();
  if (!keywords) return null;

  const token = await obterToken();
  if (!token) return null;

  const limite = Math.max(1, Math.min(10, Math.round(opts.limite ?? 10)));
  const pagina = Math.max(1, Math.min(10, Math.round(opts.pagina ?? 1)));
  const partnerTag = (opts.tag ?? process.env.AMAZON_TAG ?? "").trim();

  const body: Record<string, unknown> = {
    keywords,
    itemCount: limite,
    itemPage: pagina,
    condition: "New",
    availability: "Available",
    resources: RECURSOS_BUSCA,
  };
  if (partnerTag) body.partnerTag = partnerTag;
  if (opts.sortBy) body.sortBy = opts.sortBy;

  try {
    const r = await fetch(`${API_BASE}/catalog/v1/searchItems`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-marketplace": marketplace(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;

    const j = (await r.json()) as any;
    const itens = pick(j, "itemsResult.items", "ItemsResult.Items", "items") ?? [];
    if (!Array.isArray(itens)) return null;

    const out: OfertaAmazon[] = [];
    for (const it of itens) {
      const asin = String(pick(it, "asin", "ASIN") ?? "").toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;

      const precoRaw = pick(it, "offers.listings[0].price.amount", "Offers.Listings[0].Price.Amount");
      const preco = typeof precoRaw === "number" ? precoRaw : Number(precoRaw ?? 0);
      if (!preco || preco <= 0) continue; // sem preço não dá para postar oferta

      const baseRaw = pick(it, "offers.listings[0].price.savingBasis", "Offers.Listings[0].Price.SavingBasis");
      const descontoRaw = pick(it, "offers.listings[0].price.savingPercentage", "Offers.Listings[0].Price.SavingPercentage");
      const pct = typeof descontoRaw === "number" ? descontoRaw : 0;
      const precoDe =
        typeof baseRaw === "number" && baseRaw > preco
          ? baseRaw
          : pct > 0
            ? Math.round((preco / (1 - pct / 100)) * 100) / 100
            : null;

      const estrelas = pick(it, "customerReviews.starRating.value", "CustomerReviews.StarRating.Value");
      const nAval = pick(it, "customerReviews.count", "CustomerReviews.Count");
      const rank = pick(it, "browseNodeInfo.browseNodes.salesRank.value", "BrowseNodeInfo.BrowseNodes.SalesRank.Value");

      out.push({
        asin,
        titulo: String(pick(it, "itemInfo.title.displayValue", "ItemInfo.Title.DisplayValue") ?? "").trim(),
        imagem:
          pick(it, "images.primary.medium.url", "Images.Primary.Medium.URL") ??
          pick(it, "images.primary.large.url", "Images.Primary.Large.URL") ??
          null,
        preco,
        precoDe,
        avaliacao: typeof estrelas === "number" ? estrelas : 0,
        avaliacoes: typeof nAval === "number" ? nAval : 0,
        // rank de vendas menor = mais vendido; usamos como proxy invertido
        vendasProxy: typeof rank === "number" ? Math.max(0, 1000 - rank) : 0,
        link: `https://www.amazon.com.br/dp/${asin}`,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Categorias (browse nodes) da Amazon — exige credencial. */
export async function listarBrowseNodes(ids: string[]): Promise<{ id: string; nome: string }[] | null> {
  if (!credenciaisAmazon()) return null;
  if (!ids.length) return null;
  const token = await obterToken();
  if (!token) return null;
  try {
    const r = await fetch(`${API_BASE}/catalog/v1/getBrowseNodes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-marketplace": marketplace(),
      },
      body: JSON.stringify({
        partnerTag: (process.env.AMAZON_TAG ?? "").trim(),
        browseNodeIds: ids.slice(0, 10),
        resources: ["browseNodes.ancestor", "browseNodes.children"],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const nodes = pick(j, "browseNodesResult.browseNodes", "BrowseNodesResult.BrowseNodes") ?? [];
    if (!Array.isArray(nodes)) return null;
    return nodes.map((n: any) => ({
      id: String(pick(n, "id", "browseNodeId") ?? ""),
      nome: String(pick(n, "name", "displayName", "displayNameValue") ?? ""),
    }));
  } catch {
    return null;
  }
}
