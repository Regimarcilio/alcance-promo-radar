/**
 * Mídia da origem — parte de RF-034.
 *
 * Com `webhookBase64: true` na instância, o webhook entrega a PRÓPRIA imagem que
 * a origem publicou (~200KB). Guardamos em disco (data/midia/) em vez de embutir
 * na fila/estado — senão o JSON viraria dezenas de MB.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { dataDirAtual } from "../config/paths.js";

export const midiaDir = join(dataDirAtual(), "midia");

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4",
};
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", mp4: "video/mp4",
};

const NOME_SEGURO = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4)$/i;

/** Grava o base64 da origem em disco e devolve o caminho (ou null). */
export function salvarMidia(base64: string, mimetype = "image/jpeg"): string | null {
  try {
    const limpo = base64.replace(/^data:[^;]+;base64,/, "");
    if (!limpo) return null;
    const ext = EXT[mimetype.toLowerCase()] ?? "jpg";
    mkdirSync(midiaDir, { recursive: true, mode: 0o700 });
    const caminho = join(midiaDir, `${randomUUID()}.${ext}`);
    writeFileSync(caminho, Buffer.from(limpo, "base64"), { mode: 0o600 });
    return caminho;
  } catch {
    return null;
  }
}

function dentroDaMidia(caminho: string): boolean {
  const raiz = realpathSync(midiaDir);
  const alvo = realpathSync(caminho);
  return alvo === raiz || alvo.startsWith(raiz + "/");
}

/**
 * Só aceita arquivos com nome UUID e extensão de mídia DENTRO de data/midia.
 * Impede que um caminho arbitrário (`/app/.env`) seja lido e enviado.
 */
export function ehArquivoMidia(caminho: string): boolean {
  try {
    if (!caminho || !NOME_SEGURO.test(basename(caminho))) return false;
    if (!existsSync(caminho)) return false;
    return dentroDaMidia(caminho);
  } catch {
    return false;
  }
}

/** Converte um caminho de mídia em base64 com mimetype, respeitando a allowlist. */
export function lerMidia(caminho: string): { base64: string; mimetype: string } | null {
  try {
    if (!ehArquivoMidia(caminho)) return null;
    const ext = (caminho.split(".").pop() ?? "jpg").toLowerCase();
    return { base64: readFileSync(caminho).toString("base64"), mimetype: MIME[ext] ?? "image/jpeg" };
  } catch {
    return null;
  }
}

/** Remove mídias mais antigas que `dias` (chamado pelo worker). */
export function limparMidiaAntiga(dias = 3): number {
  try {
    if (!existsSync(midiaDir)) return 0;
    const limite = Date.now() - dias * 86400_000;
    let n = 0;
    for (const f of readdirSync(midiaDir)) {
      const p = join(midiaDir, f);
      try {
        if (statSync(p).mtimeMs < limite) {
          rmSync(p);
          n++;
        }
      } catch { /* ignore */ }
    }
    return n;
  } catch {
    return 0;
  }
}

const HOSTS_PRIVADOS = [
  /^localhost$/i, /\.local$/i, /^127\./, /^10\./, /^192\.168\./,
  /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^\[?::1\]?$/i, /^\[?f[cd]/i, /^\[?fe80/i,
];

/**
 * URL de imagem aceitável para a Evolution buscar: http(s), sem credenciais e
 * sem host interno/privado (SSRF). A decisão é feita antes de repassar a URL.
 */
export function urlImagemSegura(bruta: string): boolean {
  try {
    const u = new URL(bruta);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.username || u.password) return false;
    if (bruta.length > 2048) return false;
    const host = u.hostname.toLowerCase();
    if (!host || !host.includes(".")) return false;
    if (HOSTS_PRIVADOS.some((re) => re.test(host))) return false;
    return true;
  } catch {
    return false;
  }
}
