import { engine, enviarViaGo, type EnvioResult } from "./evolution-go.js";

/** Dispatch abstraído (ADR-001). Roteia v2 ↔ GO via EVO_ENGINE. */
export type { EnvioResult };

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
  const temFoto = /^https?:\/\//.test(args.imagem);
  if (temFoto) return enviarMidia({ ...args, mediatype: "image" });
  const res = await fetch(`${evoUrl}/message/sendText/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: evoKey },
    // linkPreview: tenta o cartão com foto do link (se o ML permitir a leitura)
    body: JSON.stringify({ number: args.grupo, text: args.legenda, linkPreview: true }),
  });
  if (!res.ok) throw new Error(`Evolution ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return { messageId: String(json.key?.id ?? json.id ?? Date.now()), dryRun: false };
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
  if (!/^https?:\/\//.test(args.imagem) && !args.imagem.startsWith("data:")) {
    mimetype = mimetype ?? "image/jpeg";
  }
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
}
