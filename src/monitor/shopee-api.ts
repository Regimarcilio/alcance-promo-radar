/**
 * Shopee Affiliate Open API — generateShortLink (RF-032 / RN-012).
 *
 * Transforma uma URL de produto/loja Shopee no link curto de afiliado do
 * usuário (`https://shope.ee/...`). O `affiliate_id` vai embutido no link
 * devolvido pela Shopee; `subIds` (até 5) aparecem em `utm_content`.
 *
 * Autenticação (docs: affiliate.shopee.com.br/open_api):
 *   Authorization: SHA256 Credential={AppId}, Timestamp={Timestamp}, Signature={Signature}
 *   Signature = SHA256(AppId + Timestamp + Payload + Secret)
 *   - Timestamp em segundos
 *   - Payload = body JSON exato enviado no POST
 *
 * Sem SHOPEE_APP_ID/SHOPEE_APP_SECRET o módulo é INERTE (nenhuma chamada de
 * rede): o transformer mantém o link original e manda para revisão manual.
 * Qualquer falha (timeout, 401, rate limit, erro GraphQL) também devolve null;
 * quem chama decide o fallback. Nunca inventamos um link de afiliado.
 */
import { createHash } from "node:crypto";

const ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";
const MAX_SUB_IDS = 5;
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h: shortLink é estável por origem+subIds

export interface CredenciaisShopee {
  appId: string;
  secret: string;
}

let cache = new Map<string, { link: string; expiraEm: number }>();

/** Credenciais configuradas? (sem elas, nada neste módulo toca a rede) */
export function credenciaisShopee(): CredenciaisShopee | null {
  const appId = process.env.SHOPEE_APP_ID?.trim();
  const secret = process.env.SHOPEE_APP_SECRET?.trim();
  return appId && secret ? { appId, secret } : null;
}

/**
 * Sub IDs de rastreio (até 5). `SHOPEE_SUB_IDS` aceita lista separada por
 * vírgula; `SHOPEE_SUBID` (legado) entra como o primeiro quando a lista nova
 * não está definida.
 */
export function subIdsShopee(): string[] {
  const bruto = process.env.SHOPEE_SUB_IDS?.trim() || process.env.SHOPEE_SUBID?.trim() || "";
  return bruto
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SUB_IDS);
}

/** SHA-256 da concatenação exata usada pela Shopee (exportado p/ teste). */
export function assinaturaShopee(
  appId: string,
  timestamp: string,
  payload: string,
  secret: string,
): string {
  return createHash("sha256").update(`${appId}${timestamp}${payload}${secret}`).digest("hex");
}

/** Somente para testes: zera o cache entre casos. */
export function limparCacheShopee(): void {
  cache = new Map();
}

function montarQuery(originUrl: string, subIds: string[]): string {
  // Inline (em vez de variables) para casar com o exemplo oficial e não
  // depender do nome do input type do schema GraphQL da Shopee.
  return `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: ${JSON.stringify(subIds)} }) { shortLink } }`;
}

/** Aceita só links curtos da Shopee — evita gravar redirecionamento inesperado. */
function linkValido(link: string): boolean {
  try {
    const u = new URL(link);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.host.toLowerCase();
    return (
      host === "shope.ee" ||
      host.endsWith(".shope.ee") ||
      host === "shopee.com.br" ||
      host.endsWith(".shopee.com.br")
    );
  } catch {
    return false;
  }
}

/**
 * Gera o link curto de afiliado para `originUrl`.
 * Devolve null sem credenciais, com URL inválida ou em qualquer falha da API.
 */
export async function gerarLinkShopee(originUrl: string): Promise<string | null> {
  const cred = credenciaisShopee();
  if (!cred) return null;
  if (!/^https?:\/\//i.test(originUrl)) return null;

  const subIds = subIdsShopee();
  const chave = `${originUrl}|${subIds.join("\u0001")}`;
  const cacheado = cache.get(chave);
  if (cacheado && Date.now() < cacheado.expiraEm) return cacheado.link;

  const payload = JSON.stringify({ query: montarQuery(originUrl, subIds) });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = assinaturaShopee(cred.appId, timestamp, payload, cred.secret);

  try {
    const resposta = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `SHA256 Credential=${cred.appId}, Timestamp=${timestamp}, Signature=${signature}`,
      },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resposta.ok) return null;

    const json = (await resposta.json()) as {
      data?: { generateShortLink?: { shortLink?: unknown } };
      errors?: unknown;
    };
    if (json.errors && (!Array.isArray(json.errors) || json.errors.length > 0)) return null;

    const link = json.data?.generateShortLink?.shortLink;
    if (typeof link !== "string" || !linkValido(link)) return null;

    cache.set(chave, { link, expiraEm: Date.now() + CACHE_TTL_MS });
    return link;
  } catch {
    return null;
  }
}
