/**
 * Marca d'água (mascote "Guru dos Achadinhos") nas fotos enviadas pelo monitor.
 *
 * Toda foto repassada (origem ou anúncio) recebe o selo no canto inferior
 * direito, composto em memória com sharp antes do sendMedia. A rotina é
 * FAIL-OPEN: arquivo ausente, imagem inválida, formato não suportado ou
 * MONITOR_MARCA=0 devolvem `null` e o chamador envia a foto original.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export type MidiaMarcada = { media: string; mimetype: string };

/** Formatos estáticos que o sharp consegue recompor em JPEG. */
const TIPOS_IMAGEM = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

const ESCALA_PADRAO = 0.18;
const OPACIDADE_PADRAO = 1;
const TAMANHO_MIN = 72;
const TAMANHO_MAX = 220;
const FRACAO_MAXIMA = 0.42;
const MARGEM_MIN = 8;
const MARGEM_MAX = 36;
const MARGEM_FRACAO = 0.035;
const RAIO_FRACAO = 0.18;
const QUALIDADE_JPEG = 86;
const LADO_SELO_CACHE = 512;
const BYTES_MINIMOS = 1024;
const ARQUIVO_PADRAO = "image/Guru dos Achadinhos.png";

let seloCache: { chave: string; buffer: Buffer } | null = null;
const seloPorTamanho = new Map<string, Buffer>();
const MAX_SELOS_CACHE = 8;

/** Raiz do projeto tanto em dev (src/wa) quanto no build (dist/wa). */
function raizDoProjeto(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Caminho da mascote: absoluto ou relativo à raiz do projeto. */
export function caminhoMascote(): string {
  const bruto = (process.env.MONITOR_MARCA_ARQUIVO ?? "").trim() || ARQUIVO_PADRAO;
  return isAbsolute(bruto) ? bruto : resolve(raizDoProjeto(), bruto);
}

/** MONITOR_MARCA=0/false/off desliga a marca d'água. */
export function marcaAtiva(): boolean {
  const valor = String(process.env.MONITOR_MARCA ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(valor);
}

function numeroEnv(nome: string, padrao: number): number {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) ? n : padrao;
}

function opacidade(): number {
  return Math.min(1, Math.max(0.1, numeroEnv("MONITOR_MARCA_OPACIDADE", OPACIDADE_PADRAO)));
}

/**
 * Tamanho e margem do selo para uma foto de `largura`×`altura`.
 * Regra: 18% da largura, entre 72 e 220 px, nunca acima de 42% do lado
 * menor (miniaturas); margem de 3,5% da largura, entre 8 e 36 px.
 */
export function calcularGeometria(
  largura: number,
  altura: number
): { tamanho: number; margem: number } {
  const escala = Math.min(1, Math.max(0.05, numeroEnv("MONITOR_MARCA_ESCALA", ESCALA_PADRAO)));
  const bruto = Math.round(largura * escala);
  let tamanho = Math.max(TAMANHO_MIN, Math.min(TAMANHO_MAX, bruto));
  tamanho = Math.min(
    tamanho,
    Math.round(largura * FRACAO_MAXIMA),
    Math.round(altura * FRACAO_MAXIMA)
  );
  tamanho = Math.max(1, tamanho);
  const margem = Math.max(MARGEM_MIN, Math.min(MARGEM_MAX, Math.round(largura * MARGEM_FRACAO)));
  // Em imagens minúsculas a margem não pode empurrar o selo para fora.
  const margemFinal = Math.min(
    margem,
    Math.max(0, Math.floor((Math.min(largura, altura) - tamanho) / 2))
  );
  return { tamanho, margem: margemFinal };
}

function mascaraSvg(tamanho: number, raio: number, alpha: number): Buffer {
  return Buffer.from(
    `<svg width="${tamanho}" height="${tamanho}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${tamanho}" height="${tamanho}" ` +
      `rx="${raio}" ry="${raio}" fill="#ffffff" fill-opacity="${alpha}"/>` +
      `</svg>`
  );
}

/** Normaliza a mascote para 512×512 RGBA e mantém em cache. */
async function carregarSeloBase(): Promise<Buffer> {
  const chave = caminhoMascote();
  if (seloCache?.chave === chave) return seloCache.buffer;
  const original = readFileSync(chave);
  const buffer = await sharp(original)
    .resize(LADO_SELO_CACHE, LADO_SELO_CACHE, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .png()
    .toBuffer();
  seloCache = { chave, buffer };
  return buffer;
}

/** Monta (e cacheia) o selo no tamanho final, com cantos arredondados. */
async function montarSelo(tamanho: number): Promise<Buffer> {
  const alpha = opacidade();
  const chave = `${tamanho}:${alpha}`;
  const emCache = seloPorTamanho.get(chave);
  if (emCache) return emCache;
  const raio = Math.max(1, Math.round(tamanho * RAIO_FRACAO));
  const seloBase = await carregarSeloBase();
  const selo = await sharp(seloBase)
    .resize(tamanho, tamanho, { fit: "fill" })
    .composite([{ input: mascaraSvg(tamanho, raio, alpha), blend: "dest-in" }])
    .png()
    .toBuffer();
  if (seloPorTamanho.size >= MAX_SELOS_CACHE) {
    const maisAntigo = seloPorTamanho.keys().next().value;
    if (maisAntigo) seloPorTamanho.delete(maisAntigo);
  }
  seloPorTamanho.set(chave, selo);
  return selo;
}

/** Separa data URI/puro em base64 + mimetype. */
function separarMidia(media: string, mimetype?: string): { base64: string; mimetype: string } {
  const dataUri = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(media);
  if (dataUri) {
    return {
      mimetype: (mimetype ?? dataUri[1] ?? "").toLowerCase(),
      base64: dataUri[2],
    };
  }
  return { mimetype: (mimetype ?? "").toLowerCase(), base64: media };
}

/**
 * Aplica o selo e devolve JPEG em base64. `null` = mantenha a foto original.
 */
export async function aplicarMarcaDagua(
  media: string,
  mimetype?: string
): Promise<MidiaMarcada | null> {
  if (!marcaAtiva()) return null;
  try {
    const { base64, mimetype: tipo } = separarMidia(media, mimetype);
    if (!TIPOS_IMAGEM.has(tipo)) return null;
    const entrada = Buffer.from(base64, "base64");
    if (entrada.length < BYTES_MINIMOS) return null;

    const meta = await sharp(entrada).metadata();
    if (!meta.width || !meta.height) return null;
    if ((meta.pages ?? 1) > 1) return null; // animação (WebP/GIF) fica intacta

    // Auto-orientação: EXIF 5–8 troca largura/altura. Rotaciona antes de compor
    // para o selo cair no canto certo e a foto não perder a orientação no JPEG.
    let base = entrada;
    let largura = meta.width;
    let altura = meta.height;
    if ((meta.orientation ?? 1) !== 1) {
      const girada = await sharp(entrada).rotate().toBuffer({ resolveWithObject: true });
      base = girada.data;
      largura = girada.info.width;
      altura = girada.info.height;
    }

    const { tamanho, margem } = calcularGeometria(largura, altura);
    const selo = await montarSelo(tamanho);

    const saida = await sharp(base)
      .composite([
        {
          input: selo,
          left: Math.max(0, largura - tamanho - margem),
          top: Math.max(0, altura - tamanho - margem),
        },
      ])
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: QUALIDADE_JPEG })
      .toBuffer();

    return { media: saida.toString("base64"), mimetype: "image/jpeg" };
  } catch (e: any) {
    console.warn(`[marca-dagua] ignorada: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  }
}
