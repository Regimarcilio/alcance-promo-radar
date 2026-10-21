/**
 * CUPONS ML — colheita da página /cupons (com sessão, sem bloqueio).
 * Cupons de comprador são click-to-apply (token, sem código digitável):
 * usamos título+regras como linha informativa + itens elegíveis (MLB ids).
 * Códigos digitáveis (estilo Emipe: PRIMEHOJE) vêm do registro manual
 * (data/cupons.json) — o afiliado cria 1 vez no portal e cadastra aqui.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const regFile = join(dataDir, "cupons.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const URL = "https://www.mercadolivre.com.br/cupons";

export interface CupomML {
  titulo: string;
  minimo: string | null;
  limite: string | null;
  validade: string | null;
  vertical: string;
  itens: { mlbId: string; titulo: string; foto: string }[];
}

function cookies(): string {
  const viaEnv = process.env.COOKIE_ML?.trim() || "";
  if (viaEnv && !viaEnv.startsWith("cole_o_cookie")) return viaEnv;
  return "";
}

/** Verticais do ML → nossas categorias (expansível). */
const VERTICAIS: Record<string, string[]> = {
  "Eletrônicos, Áudio e Vídeo": ["MLB1000"],
  "Casa, Móveis e Decoração": ["MLB1574"],
  "Beleza e Cuidado Pessoal": ["MLB1246"],
  "Moda e acessórios": ["MLB1430", "MLB4181"],
  "Esportes e Fitness": ["MLB1276"],
  "Alimentos e Bebidas": ["MLB1403"],
  "Acessórios para Veículos": ["MLB5672"],
  "Brinquedos, Hobbies e Bebês": ["MLB1132", "MLB1384"],
  Entretenimento: ["MLB1144", "MLB1168"],
};

let cache: { em: number; cupons: (CupomML & { cats: string[] })[] } | null = null;

export async function colherCupons(): Promise<(CupomML & { cats: string[] })[]> {
  if (cache && Date.now() - cache.em < 3600000) return cache.cupons;
  const cookie = cookies();
  if (!cookie) throw new Error("SEM_COOKIE");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookie },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CUPONS_${res.status}`);
    const html = await res.text();
    if (html.includes("account-verification")) throw new Error("CUPONS_BLOQUEADO");
    // divide por seções "coupons":[ ... ]; a vertical é o último nome
    // de seção antes do array (Eletrônicos, Casa, Beleza…)
    const idxs: number[] = [];
    let k = html.indexOf('"coupons":[');
    while (k >= 0) {
      idxs.push(k);
      k = html.indexOf('"coupons":[', k + 1);
    }
    const nomesVert = Object.keys(VERTICAIS);
    const out: (CupomML & { cats: string[] })[] = [];
    idxs.forEach((pos) => {
      const antes = html.slice(Math.max(0, pos - 2500), pos);
      let secName = "";
      let lastAt = -1;
      for (const v of nomesVert) {
        const p = antes.lastIndexOf(v);
        if (p > lastAt) {
          lastAt = p;
          secName = v;
        }
      }
      const seg = html.slice(pos, pos + 400000);
      const blocos = seg.split('"campaignId":"').slice(1, 30);
      for (const b of blocos) {
        // Título de verdade (nunca número): display title > label "Cupom…" > srLabel
        const t1 = b.match(/"title":\{"text":"([^"]{3,80})"/)?.[1] ?? "";
        const t2 = b.match(/"label":"(Cupom[^"]{3,80})"/)?.[1] ?? "";
        const t3 = b.match(/"srLabel":"(Cupom[^"]{3,80})"/)?.[1] ?? "";
        const titulo = (t1 || t2 || t3).slice(0, 80);
        if (!titulo || /^[0-9\s.,%R$]+$/.test(titulo)) continue; // fora números soltos
        const minimo = b.match(/Compra mínima[^"]{0,20}/)?.[0] ?? null;
        const limite = b.match(/Limite de [^"]{0,20}/)?.[0] ?? null;
        const validade = b.match(/Vence [^"<]{3,30}/)?.[0] ?? null;
        const itens: CupomML["itens"] = [];
        const re = /"imageUrl":"(https:[^"]+?)","altText":"((?:[^"\\]|\\.){3,100})/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(b)) && itens.length < 8) {
          const idM = m[1].match(/-(MLB\d+)_/);
          if (!idM) continue;
          itens.push({
            mlbId: idM[1].replace("MLB", "MLB-"),
            titulo: m[2].replace(/\\u002F/g, "/").slice(0, 100),
            foto: m[1].replace(/\\u002F/g, "/"),
          });
        }
        const cats = Object.entries(VERTICAIS)
          .filter(([v]) => secName.toLowerCase().includes(v.split(",")[0].toLowerCase().slice(0, 8)))
          .flatMap(([, c]) => c);
        out.push({ titulo, minimo, limite, validade, vertical: secName, itens, cats });
      }
    });
    cache = { em: Date.now(), cupons: out };
    return out;
  } finally {
    clearTimeout(t);
  }
}

/** Melhor cupom para a categoria (com itens elegíveis de preferência). */
export async function cupomPara(category: string): Promise<(CupomML & { cats: string[] }) | null> {
  try {
    const todos = await colherCupons();
    const diretos = todos.filter((c) => c.cats.includes(category) && c.itens.length > 0);
    if (diretos.length > 0) return diretos[Math.floor(Math.random() * diretos.length)];
    const gerais = todos.filter((c) => c.cats.length === 0 && c.itens.length > 0);
    if (gerais.length > 0) return gerais[Math.floor(Math.random() * gerais.length)];
    return null;
  } catch {
    return null;
  }
}

// ---------- registro de códigos digitáveis (criados no portal) ----------

export interface CupomReg {
  codigo: string;
  nome: string;
}

type Registro = Record<string, string | CupomReg>;

function norm(v: string | CupomReg | undefined): CupomReg | null {
  if (!v) return null;
  if (typeof v === "string") return { codigo: v, nome: "" };
  return { codigo: v.codigo ?? "", nome: v.nome ?? "" };
}

export function lerRegistro(): Registro {
  try {
    return JSON.parse(readFileSync(regFile, "utf8"));
  } catch {
    return {};
  }
}

export function salvarRegistro(chave: string, codigo: string, nome = ""): void {
  mkdirSync(dataDir, { recursive: true });
  const r = lerRegistro();
  if (!codigo) delete r[chave];
  else r[chave] = { codigo: codigo.trim().toUpperCase(), nome: nome.trim().slice(0, 60) };
  writeFileSync(regFile, JSON.stringify(r, null, 2));
}

/** Chave: "MLB1000" ou "MLB1000:principal". */
export function codigoPara(category: string, conta?: string): string | null {
  const r = lerRegistro();
  return (
    norm(r[`${category}:${conta ?? ""}`])?.codigo ??
    norm(r[category])?.codigo ??
    null
  );
}

/** Nome amigável do código (ex. "10% OFF Voltagem"). */
export function nomeCodigo(category: string, conta?: string): string | null {
  const r = lerRegistro();
  return (
    norm(r[`${category}:${conta ?? ""}`])?.nome ||
    norm(r[category])?.nome ||
    null
  );
}
