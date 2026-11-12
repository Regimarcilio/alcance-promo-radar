import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./paths.js";

let cache: string | null = null;

/**
 * Versão do app lida do `package.json` — **fonte única de verdade**.
 *
 * Antes era um literal no `/healthz` ("0.8.0"), que envelheceu em silêncio a cada
 * release. Agora o valor vem do pacote, sem hardcode: vale tanto no dev (`tsx`)
 * quanto no container (`/app/package.json`).
 */
export function versaoDoApp(): string {
  if (cache) return cache;
  const candidatos = [
    join(projectRoot, "package.json"),
    join(process.cwd(), "package.json"),
    "/app/package.json",
  ];
  for (const caminho of candidatos) {
    try {
      const j = JSON.parse(readFileSync(caminho, "utf8"));
      const v = String(j?.version ?? "").trim();
      if (v) {
        cache = v;
        return cache;
      }
    } catch {
      /* tenta o próximo candidato */
    }
  }
  cache = "desconhecida";
  return cache;
}
