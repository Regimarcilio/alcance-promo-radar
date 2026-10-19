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
