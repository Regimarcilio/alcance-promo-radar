import { existsSync, readFileSync } from "node:fs";
import { engine, enviarViaGo, type EnvioResult } from "./evolution-go.js";

/** Dispatch abstraído (ADR-001). Roteia v2 ↔ GO via EVO_ENGINE. */
export type { EnvioResult };

/** Caminho de arquivo local (foto baixada/guardada em disco)? */
function arquivoLocal(p: string): boolean {
  if (!p || /^https?:\/\//.test(p) || p.startsWith("data:")) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Erro de rede/conexão (vale repetir)? 5xx, "Connection Closed", socket, timeout. */
function transitorio(msg: string): boolean {
  return /Evolution (sendMedia|sendText)?\s*5\d\d|Connection Closed|Precondition Required|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|terminated|other side closed/i.test(
    msg
  );
}

/**
 * Repete só erros TRANSITÓRIOS (WhatsApp/Evolution cai e volta em segundos).
 * Um 500 isolado não deve custar a oferta do ciclo.
 */
async function comRetry<T>(fn: () => Promise<T>, tentativas = 3): Promise<T> {
  let ultimo: any;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e: any) {
      ultimo = e;
      const msg = String(e?.message ?? e);
      if (i === tentativas - 1 || !transitorio(msg)) throw e;
      const espera = 2000 * (i + 1); // 2s, 4s
      console.log(
        `[dispatch] erro transitório (${msg.slice(0, 80)}) — repetindo em ${espera / 1000}s (${i + 2}/${tentativas})`
      );
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimo;
}

export async function enviarParaGrupo(args: {
  grupo: string;
  imagem: string;
  legenda: string;
  dryRun: boolean;
}): Promise<EnvioResult> {
  if (engine() === "go") return enviarViaGo(args);
  const evoUrl = process.env.EVO_URL;
  const evoKey = process.env.EVO_KEY;
  const instance = process.env.EVO_INSTANCE ?? "radar-piloto";
  if (args.dryRun || !evoUrl || !evoKey) {
    console.log(
      `[dry-run] grupo=${args.grupo} legenda=${args.legenda.length}chars imagem=${args.imagem || "(sem)"}`
    );
    return { messageId: `dryrun-${Date.now()}`, dryRun: true };
  }
  const temFoto =
    /^https?:\/\//.test(args.imagem) ||
    args.imagem.startsWith("data:") ||
    arquivoLocal(args.imagem);
  if (temFoto) return enviarMidia({ ...args, mediatype: "image" });
  return comRetry(async () => {
    const res = await fetch(`${evoUrl}/message/sendText/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: evoKey },
      // linkPreview: tenta o cartão com foto do link (se o ML permitir a leitura)
      body: JSON.stringify({ number: args.grupo, text: args.legenda, linkPreview: true }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Evolution sendText ${res.status}: ${body.slice(0, 300)}`);
    const json: any = JSON.parse(body);
    return { messageId: String(json.key?.id ?? json.id ?? Date.now()), dryRun: false };
  });
}

/**
 * Envio com mídia (foto do produto + legenda) — v2 sendMedia.
 * Aceita URL http(s) ou base64 (data:image/... ou base64 puro + mimetype).
 */
export async function enviarMidia(args: {
  grupo: string;
  imagem: string;
  legenda: string;
  dryRun: boolean;
  mediatype?: "image" | "video" | "document";
  mimetype?: string;
}): Promise<EnvioResult> {
  const evoUrl = process.env.EVO_URL;
  const evoKey = process.env.EVO_KEY;
  const instance = process.env.EVO_INSTANCE ?? "radar-piloto";
  if (args.dryRun || !evoUrl || !evoKey) {
    console.log(`[dry-run:midia] grupo=${args.grupo} legenda=${args.legenda.length}chars`);
    return { messageId: `dryrun-midia-${Date.now()}`, dryRun: true };
  }
  let media = args.imagem;
  let mimetype = args.mimetype;
  if (arquivoLocal(args.imagem)) {
    // foto guardada em disco (ex.: a imagem que a ORIGEM publicou) → manda em base64
    const ext = (args.imagem.split(".").pop() ?? "jpg").toLowerCase();
    mimetype =
      mimetype ??
      ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext] ??
      "image/jpeg";
    media = readFileSync(args.imagem).toString("base64");
  } else if (!/^https?:\/\//.test(args.imagem) && !args.imagem.startsWith("data:")) {
    mimetype = mimetype ?? "image/jpeg";
  }
  return comRetry(async () => {
    const res = await fetch(`${evoUrl}/message/sendMedia/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: evoKey },
      body: JSON.stringify({
        number: args.grupo,
        mediatype: args.mediatype ?? "image",
        ...(mimetype ? { mimetype } : {}),
        caption: args.legenda,
        media,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Evolution sendMedia ${res.status}: ${body.slice(0, 300)}`);
    try {
      const json: any = JSON.parse(body);
      return { messageId: String(json.key?.id ?? json.id ?? Date.now()), dryRun: false };
    } catch {
      return { messageId: `midia-${Date.now()}`, dryRun: false };
    }
  });
}
