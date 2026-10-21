/**
 * Expansão de links no domínio de redirecionamento das próprias origens (E6/RF-031).
 * Algumas origens postam links no domínio delas (ex.: oferta.emipefps.com/amazon/XXXX)
 * que resolvem por API para a URL final (amazon.com.br/dp/ASIN?tag=...). Sem expandir,
 * o link cai como "desconhecido" na allowlist e a oferta morre em revisão "sem link".
 */
import { classificar, extrairId, type LinkDetectado } from "./parser.js";

interface Resolvedor {
  host: RegExp;
  resolver: (url: string) => Promise<string | null>;
}

/**
 * Epipe (grupo #55): a página é um shell JS que chama
 * `POST https://oferta.emipefps.com/api/public/abrir-link {codigo}` e recebe
 * `{destino}` (ex.: https://www.amazon.com.br/dp/B0DWGWN8GY?...&tag=emipefps0f-20).
 * Chamamos essa API direto — não precisa executar o JavaScript da página.
 */
async function viaEpipe(url: string): Promise<string | null> {
  const u = new URL(url);
  const codigo = u.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!codigo) return null;
  const r = await fetch(`https://${u.host}/api/public/abrir-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ codigo, dispositivo: "computador", token: null, referer: "" }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as { destino?: unknown } | null;
  const destino = typeof j?.destino === "string" ? j.destino : "";
  return /^https?:\/\//i.test(destino) ? destino : null;
}

/**
 * Encurtador genérico: segue UM redirect (301/302/303/307) e devolve o
 * destino. Vários grupos de achadinhos postam link curto (tidd.ly, bit.ly,
 * cutt.ly, encurtador.com.br…) — sem resolver, a oferta morre em revisão
 * "link não reconhecido" e o volume some.
 */
async function viaRedirect(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": UA_REDIRECT, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(6000),
    });
    const loc = r.headers.get("location");
    if (loc && /^https?:\/\//i.test(loc)) return loc;
    return null;
  } catch {
    return null;
  }
}

/** Hosts de encurtador conhecidos (resolvidos por 1 salto de redirect). */
const ENCURTADORES =
  /(^|\.)(tidd\.ly|bit\.ly|cutt\.ly|tinyurl\.com|shorturl\.at|is\.gd|rebrand\.ly|short\.gy|vk\.cc|rb\.gy|qrco\.de|lnkd\.in|t\.co|t\.me|encurtador\.com\.br|meulink\.com\.br|linkr\.com\.br|shorturl\.com|0x0\.st|clck\.ru|tr\.ee|shrinkme\.io|shorturl\.br)$/i;

const RESOLVEDORES: Resolvedor[] = [
  { host: /(^|\.)emipefps\.com$/i, resolver: viaEpipe },
  { host: ENCURTADORES, resolver: viaRedirect },
];

/**
 * Tenta expandir um link desconhecido (até 3 saltos) até achar um programa da
 * allowlist. Retorna o LinkDetectado final — com id quando o destino traz —
 * ou null (host sem resolvedor, API fora do ar, destino ainda desconhecido...).
 */
export async function expandirLink(url: string): Promise<LinkDetectado | null> {
  let atual = url;
  for (let rodada = 0; rodada < 3; rodada++) {
    let host = "";
    try {
      host = new URL(atual).host;
    } catch {
      return null;
    }
    const res = RESOLVEDORES.find((r) => r.host.test(host));
    if (!res) return null;
    const final = await res.resolver(atual).catch(() => null);
    if (!final) return null;
    const { programa, host: hostFinal } = classificar(final);
    if (programa !== "desconhecido") {
      return { url: final, host: hostFinal, programa, idProduto: extrairId(final, programa) };
    }
    atual = final; // destino ainda desconhecido → tenta mais um salto na cadeia
  }
  return null;
}

const UA_REDIRECT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Encurtadores Amazon (`amzn.to`, `amzn.com.br`) respondem com 301/302 e NÃO
 * repassam query params — aplicar `?tag=` direto neles perderia a comissão.
 * Resolve o redirect até chegar num host de produto Amazon e devolve a URL
 * final; null quando não conseguir (o chamador mantém o link original).
 */
export async function expandirCurtoAmazon(url: string): Promise<string | null> {
  let atual = url;
  for (let salto = 0; salto < 4; salto++) {
    let host = "";
    try {
      host = new URL(atual).host.toLowerCase();
    } catch {
      return null;
    }
    const ehEncurtador = host === "amzn.to" || host === "amzn.com.br" || host.endsWith(".amzn.com.br");
    if (!ehEncurtador) {
      return classificar(atual).programa === "amazon" ? atual : null;
    }
    const loc = await obterLocation(atual);
    if (!loc) return null;
    atual = new URL(loc, atual).toString();
  }
  return null;
}

/** HEAD manual primeiro (sem baixar body); GET com follow como reserva. */
async function obterLocation(url: string): Promise<string | null> {
  try {
    const h = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": UA_REDIRECT },
      signal: AbortSignal.timeout(8000),
    });
    const loc = h.headers.get("location");
    if (loc) return loc;
  } catch {
    /* cai no GET */
  }
  try {
    const g = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA_REDIRECT },
      signal: AbortSignal.timeout(10000),
    });
    return g.url && g.url !== url ? g.url : null;
  } catch {
    return null;
  }
}
