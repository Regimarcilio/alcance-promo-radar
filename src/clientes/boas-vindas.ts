/**
 * BOAS-VINDAS — DM automática ao contato recém-adicionado ao grupo.
 *
 * A adição é 6h–22h e as ofertas vão até 23h; quem entra às 6h passaria horas
 * sem estímulo e sairia. Por isso, assim que o add é CONFIRMADO (status 200),
 * o mesmo número que adicionou manda uma imagem da marca + legenda com o link
 * do TikTok. Não vai para o grupo — é sempre DM.
 *
 * Decisões:
 * - só dispara com confirmação real do add (nunca em sucesso fantasma);
 * - uma vez por número (padrão: reenvia só depois de 30 dias);
 * - falha da boas-vindas NÃO derruba a adição;
 * - imagem local é validada (dentro do projeto, extensão e tamanho) antes de
 *   virar base64 — nada de caminho arbitrário.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { dataDirAtual, projectRoot } from "../config/paths.js";
import { proximaInstancia } from "../wa/rotacao.js";
import { marcarEnvioAtivo } from "../monitor/envio-lock.js";

export const LEGENDA_PADRAO = `🎉 *Bem-vindo ao Mano dos Achadinhos!*

As melhores ofertas de *tech, beleza, games e casa*, todos os dias, com desconto real e link direto.

🛒 Ofertas selecionadas
🚚 Entrega segura
✅ Compra confiável

Me segue no TikTok:
👉 https://www.tiktok.com/@mano.dos.achadinh

Tem achadinho novo todos os dias. 🔥`;

const IMAGEM_PADRAO = "image/Mano dos Achadinhos_ Ofertas Tech e Lifestyle.png";
const MAX_BYTES = 8 * 1024 * 1024;
const EXT_OK = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface LegendaOverride {
  legenda?: string;
  imagem?: string;
}

export interface ResultadoBoasVindas {
  ok: boolean;
  /** true = já tinha sido enviada (ou o recurso está desligado) */
  pulado?: boolean;
  numero?: string;
  instancia?: string;
  messageId?: string;
  erro?: string;
}

interface Registro {
  em: string;
  ok: boolean;
  instancia?: string;
  erro?: string;
}

interface Store {
  enviados: Record<string, Registro>;
  ultimas: Array<Registro & { numero: string }>;
}

function arquivo(): string {
  return join(dataDirAtual(), "boas-vindas.json");
}

function vazio(): Store {
  return { enviados: {}, ultimas: [] };
}

function carregar(): Store {
  try {
    if (!existsSync(arquivo())) return vazio();
    const raw: any = JSON.parse(readFileSync(arquivo(), "utf8"));
    return {
      enviados: raw?.enviados && typeof raw.enviados === "object" ? raw.enviados : {},
      ultimas: Array.isArray(raw?.ultimas) ? raw.ultimas.slice(0, 50) : [],
    };
  } catch {
    return vazio();
  }
}

function salvar(s: Store): void {
  try {
    mkdirSync(dataDirAtual(), { recursive: true, mode: 0o700 });
    const destino = arquivo();
    const tmp = `${destino}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, destino);
  } catch {
    /* mantém o envio mesmo sem persistir o histórico */
  }
}

function num(nome: string, padrao: number): number {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) ? v : padrao;
}

/** BOAS_VINDAS_ATIVO=0/false/off desliga o disparo automático. */
export function boasVindasAtivo(): boolean {
  const v = String(process.env.BOAS_VINDAS_ATIVO ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function legendaBoasVindas(): string {
  const v = (process.env.BOAS_VINDAS_LEGENDA ?? "").trim();
  return v || LEGENDA_PADRAO;
}

export function caminhoImagemBoasVindas(): string {
  const bruto = (process.env.BOAS_VINDAS_IMAGEM ?? "").trim() || IMAGEM_PADRAO;
  return isAbsolute(bruto) ? bruto : resolve(projectRoot, bruto);
}

/** Imagem tem que estar DENTRO do projeto, existir, ser PNG/JPG/WEBP e caber no limite. */
export function validarImagemBoasVindas(caminho = caminhoImagemBoasVindas()): { ok: boolean; erro?: string } {
  const abs = resolve(caminho);
  const rel = relative(projectRoot, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, erro: "imagem fora do projeto" };
  if (!existsSync(abs)) return { ok: false, erro: "imagem não encontrada" };
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, erro: "imagem inacessível" };
  }
  if (!st.isFile()) return { ok: false, erro: "imagem não é arquivo" };
  if (st.size > MAX_BYTES) return { ok: false, erro: "imagem acima de 8 MB" };
  if (st.size === 0) return { ok: false, erro: "imagem vazia" };
  if (!EXT_OK.has(extname(abs).toLowerCase())) return { ok: false, erro: "formato de imagem não suportado" };
  return { ok: true };
}

let cache: { caminho: string; mtimeMs: number; base64: string; mimetype: string } | null = null;

function lerImagem(): { base64: string; mimetype: string } {
  const caminho = caminhoImagemBoasVindas();
  const v = validarImagemBoasVindas(caminho);
  if (!v.ok) throw new Error(`imagem de boas-vindas: ${v.erro}`);
  const st = statSync(caminho);
  if (cache && cache.caminho === caminho && cache.mtimeMs === st.mtimeMs) return cache;
  const ext = extname(caminho).toLowerCase();
  const mimetype = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const base64 = readFileSync(caminho).toString("base64");
  cache = { caminho, mtimeMs: st.mtimeMs, base64, mimetype };
  return cache;
}

/** Normaliza para só dígitos (10–15). JID @lid não é telefone e é recusado. */
export function normalizarNumeroBoasVindas(bruto: string): string | null {
  const texto = String(bruto ?? "").trim();
  if (/@lid$/i.test(texto)) return null;
  const d = texto.replace(/\D/g, "");
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

/** Já recebeu boas-vindas nos últimos N dias? */
export function jaEnviado(numero: string, agora = Date.now()): boolean {
  const n = normalizarNumeroBoasVindas(numero);
  if (!n) return false;
  const r = carregar().enviados[n];
  if (!r?.ok) return false;
  const dias = num("BOAS_VINDAS_REENVIO_DIAS", 30);
  const limite = agora - Math.max(0, dias) * 86400_000;
  const em = new Date(r.em).getTime();
  return Number.isFinite(em) && em > limite;
}

/** Grava o resultado (também usado pelos testes). */
export function registrarBoasVindas(numero: string, r: Omit<Registro, "em">): void {
  const n = normalizarNumeroBoasVindas(numero) ?? String(numero);
  const s = carregar();
  const reg: Registro = { em: new Date().toISOString(), ...r };
  s.enviados[n] = reg;
  s.ultimas.unshift({ numero: n, ...reg });
  s.ultimas = s.ultimas.slice(0, 50);
  salvar(s);
}

function transitorio(msg: string, http = 0): boolean {
  if (http === 408 || http === 429 || http >= 500) return true;
  return /Evolution sendMedia 5\d\d|Connection Closed|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|other side closed/i.test(msg);
}

/**
 * Envia a boas-vindas por DM. `instancia` deve ser o número que fez a adição;
 * se não vier, usa o rodízio normal. `forcar` ignora o dedup (teste manual).
 * `legendaOverride` permite sobrescrever legenda/imagem para um job específico.
 */
export async function enviarBoasVindas(
  numero: string,
  opts: { instancia?: string; forcar?: boolean; legendaOverride?: LegendaOverride } = {},
): Promise<ResultadoBoasVindas> {
  if (!boasVindasAtivo() && !opts.forcar) return { ok: false, pulado: true, erro: "boas-vindas desativadas" };
  const n = normalizarNumeroBoasVindas(numero);
  if (!n) return { ok: false, erro: "número inválido" };
  if (!opts.forcar && jaEnviado(n)) return { ok: true, pulado: true, numero: n };

  const evoUrl = process.env.EVO_URL;
  const evoKey = process.env.EVO_KEY;
  if (!evoUrl || !evoKey) return { ok: false, numero: n, erro: "Evolution não configurada (EVO_URL/EVO_KEY)" };

  // Imagem: override se válido, senão padrão
  let imagem: { base64: string; mimetype: string };
  if (opts.legendaOverride?.imagem) {
    const caminho = resolve(projectRoot, opts.legendaOverride.imagem);
    const abs = resolve(caminho);
    const rel = relative(projectRoot, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, numero: n, erro: "imagem de override fora do projeto" };
    }
    const v = validarImagemBoasVindas(caminho);
    if (!v.ok) return { ok: false, numero: n, erro: `imagem override: ${v.erro}` };
    const st = statSync(caminho);
    const ext = extname(caminho).toLowerCase();
    const mimetype = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const base64 = readFileSync(caminho).toString("base64");
    imagem = { base64, mimetype };
  } else {
    try {
      imagem = lerImagem();
    } catch (e: any) {
      return { ok: false, numero: n, erro: String(e?.message ?? e) };
    }
  }

  const legenda = opts.legendaOverride?.legenda ?? legendaBoasVindas();
  const tentativas = Math.max(1, Math.min(3, num("BOAS_VINDAS_TENTATIVAS", 3)));
  const falhas: string[] = [];
  let ultimoErro = "";
  let instancia: string | undefined;

  for (let t = 0; t < tentativas; t++) {
    instancia = t === 0 && opts.instancia ? opts.instancia : await proximaInstancia(falhas);
    try {
      const res = await fetch(`${evoUrl}/message/sendMedia/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: evoKey },
        body: JSON.stringify({
          number: `+${n}`,
          mediatype: "image",
          mimetype: imagem.mimetype,
          caption: legenda,
          media: imagem.base64,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.text().catch(() => "");
      if (!res.ok) {
        ultimoErro = `Evolution sendMedia ${res.status}: ${body.slice(0, 200)}`;
        falhas.push(instancia);
        if (t < tentativas - 1 && transitorio(ultimoErro, res.status)) {
          await new Promise((r) => setTimeout(r, 2000 * (t + 1)));
          continue;
        }
        break;
      }
      const json: any = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      const messageId = String(json?.key?.id ?? json?.id ?? "");
      marcarEnvioAtivo(); // DM também ocupa a conta: adição espera a janela
      registrarBoasVindas(n, { ok: true, instancia });
      return { ok: true, numero: n, instancia, messageId };
    } catch (e: any) {
      ultimoErro = String(e?.message ?? e);
      falhas.push(instancia);
      if (t < tentativas - 1 && transitorio(ultimoErro)) {
        await new Promise((r) => setTimeout(r, 2000 * (t + 1)));
        continue;
      }
      break;
    }
  }

  registrarBoasVindas(n, { ok: false, instancia, erro: ultimoErro || "falha no envio" });
  return { ok: false, numero: n, instancia, erro: ultimoErro || "falha no envio" };
}

export interface EstadoBoasVindas {
  ativo: boolean;
  imagem: string;
  imagemOk: boolean;
  legenda: string;
  total: number;
  ultimas: Array<Registro & { numero: string }>;
}

export function estadoBoasVindas(): EstadoBoasVindas {
  const s = carregar();
  const v = validarImagemBoasVindas();
  return {
    ativo: boasVindasAtivo(),
    imagem: caminhoImagemBoasVindas(),
    imagemOk: v.ok,
    legenda: legendaBoasVindas(),
    total: Object.values(s.enviados).filter((r) => r.ok).length,
    ultimas: s.ultimas.slice(0, 20),
  };
}
