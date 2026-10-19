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

const RESOLVEDORES: Resolvedor[] = [
  { host: /(^|\.)emipefps\.com$/i, resolver: viaEpipe },
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
