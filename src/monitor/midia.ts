/**
 * Mídia da origem — E6 / RF-037.
 *
 * Com `webhookBase64: true` na instância, o webhook entrega a PRÓPRIA imagem que
 * a origem publicou (`data.message.base64`, ~200KB). Guardamos em disco
 * (data/midia/) em vez de embutir na fila/estado — senão o JSON viraria dezenas
 * de MB.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const midiaDir = join(root, "data", "midia");

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4",
};
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", mp4: "video/mp4",
};

/** Grava o base64 da origem em disco e devolve o caminho (ou null). */
export function salvarMidia(base64: string, mimetype = "image/jpeg"): string | null {
  try {
    const limpo = base64.replace(/^data:[^;]+;base64,/, "");
    if (!limpo) return null;
    const ext = EXT[mimetype.toLowerCase()] ?? "jpg";
    mkdirSync(midiaDir, { recursive: true });
    const caminho = join(midiaDir, `${randomUUID()}.${ext}`);
    writeFileSync(caminho, Buffer.from(limpo, "base64"));
    return caminho;
  } catch {
    return null;
  }
}

/** É um arquivo de mídia nosso (existe em disco)? */
export function ehArquivoMidia(caminho: string): boolean {
  try {
    return !!caminho && caminho.startsWith(midiaDir) && existsSync(caminho);
  } catch {
    return false;
  }
}

export function lerMidia(caminho: string): { base64: string; mimetype: string } | null {
  try {
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
