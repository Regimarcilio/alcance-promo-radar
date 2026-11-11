/**
 * MÍDIA — resolução segura de imagens servidas pelo painel.
 *
 * O painel mostra o preview da imagem de boas-vindas antes de publicar. Como o
 * `<img src>` do navegador aceita qualquer caminho, a resolução precisa ser
 * blindada: nada de `..`, nada de subdiretório, nada de extensão executável e
 * o arquivo tem que estar DENTRO da base permitida (`image/` ou `data/`).
 */
import { extname, isAbsolute, relative, resolve } from "node:path";

/** Extensões que o painel pode exibir no preview. */
export const EXT_MIDIA_OK = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export type MidiaResolvida =
  | { ok: true; alvo: string; mime: string }
  | { ok: false; motivo: string };

function mimeDe(ext: string): string {
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg"; // .jpg / .jpeg
}

/**
 * Resolve `nomeBruto` (já decodificado da URL) dentro de `base`.
 * Aceita só um arquivo de imagem direto na base — sem `..`, sem barra, sem NUL.
 */
export function resolverMidia(base: string, nomeBruto: string): MidiaResolvida {
  const nome = String(nomeBruto ?? "").trim();
  if (!nome) return { ok: false, motivo: "vazio" };
  if (nome.includes("\0")) return { ok: false, motivo: "nulo" };
  if (nome.includes("..")) return { ok: false, motivo: "traversal" };
  if (/[\\/]/.test(nome)) return { ok: false, motivo: "subdiretório" };
  if (nome.startsWith(".")) return { ok: false, motivo: "oculto" };

  const ext = extname(nome).toLowerCase();
  if (!EXT_MIDIA_OK.has(ext)) return { ok: false, motivo: "extensão" };

  const alvo = resolve(base, nome);
  const rel = relative(base, alvo);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, motivo: "fora da base" };

  return { ok: true, alvo, mime: mimeDe(ext) };
}
