/**
 * VITRINE: prateleira de ofertas do perfil social de afiliado.
 * É a ÚNICA fonte de dados reais (título+preço+foto) alcançável desta
 * rede: o HTML vem com polycards embutidos, sem bloqueio.
 * - Feed: long_url capturado de qualquer createLink (social/{tag}?...).
 * - Foto: https://http2.mlstatic.com/D_NQ_NP_{picId}-F.webp (provado 200).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const feedFile = join(dataDir, "vitrine-feed.json");
const mapFile = join(dataDir, "vitrine-map.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export interface VitrineItem {
  mlbId: string;
  titulo: string;
  preco: number;
  foto: string;
  url: string;
  catLeaf: string;
}

export function fotoDe(picId: string): string {
  // JPEG: WhatsApp nem sempre renderiza webp como foto (vira sticker ou some)
  return `https://http2.mlstatic.com/D_NQ_NP_${picId}-O.jpg`;
}

/** Guarda a URL do feed (long_url) capturada de um createLink. */
export function registrarFeed(feedUrl: string): void {
  if (!/^https?:\/\//.test(feedUrl)) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(feedFile, JSON.stringify({ feedUrl, coletadoEm: new Date().toISOString() }, null, 2));
}

export function lerFeedUrl(): string | null {
  try {
    const j = JSON.parse(readFileSync(feedFile, "utf8"));
    return typeof j.feedUrl === "string" ? j.feedUrl : null;
  } catch {
    return null;
  }
}

function cookies(): string {
  // no container o .env vem por ambiente (env_file), não por arquivo
  const viaEnv = process.env.COOKIE_ML?.trim() || "";
  if (viaEnv && !viaEnv.startsWith("cole_o_cookie")) return viaEnv;
  try {
    for (const l of readFileSync(join(root, ".env"), "utf8").split("\n")) {
      if (l.startsWith("COOKIE_ML=")) {
        let v = l.slice("COOKIE_ML=".length).trim();
        if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
        return v;
      }
    }
  } catch {
    /* sem arquivo */
  }
  return "";
}

/** Baixa a vitrine e extrai os polycards. */
export async function colher(feedUrl?: string): Promise<VitrineItem[]> {
  const url = feedUrl ?? lerFeedUrl();
  if (!url) throw new Error("SEM_FEED: gere um link (colar/enviar) para capturar a vitrine.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookies() },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`VITRINE_${res.status}`);
    const html = await res.text();
    if (html.includes("account-verification") || !html.includes('"polycards"')) {
      throw new Error("VITRINE_BLOQUEADA");
    }
    const i = html.indexOf('"polycards":[');
    const seg = html.slice(i, i + 400000);
    const cards = seg.split('"unique_id":"').slice(1);
    const vistos = new Set<string>();
    const out: VitrineItem[] = [];
    for (const c of cards) {
      const mid = c.match(/"id":"(MLB\d+)"/);
      const t = c.match(/"title":\{"text":"((?:[^"\\]|\\.)*)"/);
      const p = c.match(/"current_price":\{"value":([\d.]+)/);
      const pic = c.match(/"pictures":\[\{"id":"([^"]+)"/);
      const cat = c.match(/"category_id":"(MLB\d+)"/);
      if (!mid || vistos.has(mid[1])) continue;
      vistos.add(mid[1]);
      // URL canônica pelo ID do anúncio: o createLink rejeita rotas /p/ e links curtos (erro 111)
      const numId = mid[1].replace(/^MLB-?/, "");
      out.push({
        mlbId: `MLB-${numId}`,
        titulo: t ? t[1].replace(/\\"/g, '"').slice(0, 120) : mid[1],
        preco: p ? Number(p[1]) : 0,
        foto: pic ? fotoDe(pic[1]) : "",
        url: `https://produto.mercadolivre.com.br/MLB-${numId}`,
        catLeaf: cat ? cat[1] : "",
      });
    }
    return out.filter((o) => o.preco > 0);
  } finally {
    clearTimeout(t);
  }
}

// ---------- mapa folha -> categoria do app ----------

export function lerMapaVitrine(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(mapFile, "utf8"));
  } catch {
    return {};
  }
}

export function definirMapaVitrine(leaf: string, category: string): void {
  mkdirSync(dataDir, { recursive: true });
  const m = lerMapaVitrine();
  if (!category) delete m[leaf];
  else m[leaf] = category;
  writeFileSync(mapFile, JSON.stringify(m, null, 2));
}

export function folhasDescobertas(items: VitrineItem[]): { leaf: string; qtd: number; exemplo: string }[] {
  const agg = new Map<string, { qtd: number; exemplo: string }>();
  for (const o of items) {
    if (!o.catLeaf) continue;
    const a = agg.get(o.catLeaf) ?? { qtd: 0, exemplo: o.titulo };
    a.qtd++;
    agg.set(o.catLeaf, a);
  }
  return [...agg.entries()].map(([leaf, v]) => ({ leaf, qtd: v.qtd, exemplo: v.exemplo }));
}
