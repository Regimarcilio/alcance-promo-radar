import { engine, enviarViaGo, type EnvioResult } from "./evolution-go.js";
import { proximaInstancia, registrarEnvio } from "./rotacao.js";
import { marcarEnvioAtivo } from "../monitor/envio-lock.js";
import { ehArquivoMidia, lerMidia, urlImagemSegura } from "../monitor/midia.js";

/** Dispatch abstraído (ADR-001). Roteia v2 ↔ GO via EVO_ENGINE. */
export type { EnvioResult };

/** Erro de rede/conexão (vale repetir)? 5xx, "Connection Closed", socket, timeout. */
export function ehErroTransitorio(msg: string): boolean {
  return /Evolution (sendMedia|sendText)?\s*5\d\d|Connection Closed|Precondition Required|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|terminated|other side closed/i.test(
    msg
  );
}

/**
 * Repete só erros TRANSITÓRIOS (WhatsApp/Evolution cai e volta em segundos).
 * Um 500 isolado não deve custar a oferta do ciclo.
 */
async function comRetry<T>(fn: (instancia: string) => Promise<T>, tentativas = 3): Promise<T> {
  let ultimo: any;
  const falhas: string[] = [];
  for (let i = 0; i < tentativas; i++) {
    // cada tentativa sorteia de novo, ignorando quem acabou de falhar
    const instancia = await proximaInstancia(falhas);
    try {
      const r = await fn(instancia);
      registrarEnvio(instancia);
      marcarEnvioAtivo(); // o envio tem prioridade sobre adições ao grupo
      return r;
    } catch (e: any) {
      ultimo = e;
      falhas.push(instancia);
      const msg = String(e?.message ?? e);
      if (i === tentativas - 1 || !ehErroTransitorio(msg)) throw e;
      const espera = 2000 * (i + 1); // 2s, 4s
      console.log(
        `[dispatch] erro transitório (${msg.slice(0, 80)}) — repetindo em ${espera / 1000}s (${i + 2}/${tentativas})`
      );
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimo;
}

/**
 * Valida a origem da imagem antes do envio:
 * - arquivo local: SOMENTE dentro de data/midia com nome UUID;
 * - URL: http(s), sem credenciais e sem host privado/loopback (anti-SSRF);
 * - data URI: apenas image/*.
 */
export function validarImagem(imagem: string): void {
  if (!imagem) return;
  if (/^https?:\/\//i.test(imagem)) {
    if (!urlImagemSegura(imagem)) throw new Error("imagem remota recusada (URL insegura)");
    return;
  }
  if (imagem.startsWith("data:")) {
    if (!/^data:image\//i.test(imagem)) throw new Error("data URI de imagem inválido");
    return;
  }
  if (!ehArquivoMidia(imagem)) throw new Error("caminho de imagem não permitido");
}

/**
 * Baixa a imagem no PRÓPRIO manager e manda em base64 para a Evolution.
 *
 * Evita depender do DNS/TLS do container da Evolution (EAI_AGAIN em
 * http2.mlstatic.com já derrubou envios) e reduz o tempo do sendMedia.
 * Se o download falhar, mantém a URL: a Evolution ainda pode buscá-la.
 */
async function prepararImagem(imagem: string): Promise<{ media: string; mimetype?: string }> {
  if (!/^https?:\/\//i.test(imagem)) return { media: imagem };
  try {
    const r = await fetch(imagem, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!urlImagemSegura(r.url)) throw new Error("redirect para URL insegura");
    const tipo = String(r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!tipo.startsWith("image/")) throw new Error(`content-type ${tipo || "ausente"}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) throw new Error("imagem vazia");
    if (buf.length > 8 * 1024 * 1024) throw new Error("imagem > 8 MB");
    return { media: buf.toString("base64"), mimetype: tipo };
  } catch (e: any) {
    console.log(`[dispatch] download da imagem falhou (${String(e?.message ?? e).slice(0, 80)}) — usando URL`);
    return { media: imagem };
  }
}

async function enviarTexto(args: {
  grupo: string;
  legenda: string;
}): Promise<EnvioResult> {
  const evoUrl = process.env.EVO_URL;
  const evoKey = process.env.EVO_KEY;
  if (!evoUrl || !evoKey) throw new Error("Evolution não configurada (EVO_URL/EVO_KEY) — envio abortado");
  return comRetry(async (instance) => {
    const res = await fetch(`${evoUrl}/message/sendText/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: evoKey },
      body: JSON.stringify({ number: args.grupo, text: args.legenda, linkPreview: true }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Evolution sendText ${res.status}: ${body.slice(0, 300)}`);
    const json: any = JSON.parse(body);
    return { messageId: String(json.key?.id ?? json.id ?? Date.now()), dryRun: false };
  });
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
  if (args.dryRun) {
    console.log(
      `[dry-run] grupo=${args.grupo} legenda=${args.legenda.length}chars imagem=${args.imagem || "(sem)"}`
    );
    return { messageId: `dryrun-${Date.now()}`, dryRun: true };
  }
  if (!evoUrl || !evoKey) {
    throw new Error("Evolution não configurada (EVO_URL/EVO_KEY) — envio abortado");
  }
  validarImagem(args.imagem);
  const temFoto =
    /^https?:\/\//.test(args.imagem) ||
    args.imagem.startsWith("data:") ||
    ehArquivoMidia(args.imagem);
  if (temFoto) {
    try {
      return await enviarMidia({ ...args, mediatype: "image" });
    } catch (e: any) {
      // Foto é acessório: se o sendMedia falhar (CDN, conexão do número,
      // formato), a oferta NÃO pode ficar presa. Reenvia só o texto/link.
      console.log(
        `[dispatch] sendMedia falhou (${String(e?.message ?? e).slice(0, 100)}) — reenviando só texto`
      );
      return enviarTexto(args);
    }
  }
  return enviarTexto(args);
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
  if (args.dryRun) {
    console.log(`[dry-run:midia] grupo=${args.grupo} legenda=${args.legenda.length}chars`);
    return { messageId: `dryrun-midia-${Date.now()}`, dryRun: true };
  }
  if (!evoUrl || !evoKey) {
    throw new Error("Evolution não configurada (EVO_URL/EVO_KEY) — envio de mídia abortado");
  }
  validarImagem(args.imagem);
  let media = args.imagem;
  let mimetype = args.mimetype;
  if (/^https?:\/\//i.test(args.imagem)) {
    const baixada = await prepararImagem(args.imagem);
    media = baixada.media;
    mimetype = mimetype ?? baixada.mimetype;
  } else if (ehArquivoMidia(args.imagem)) {
    // foto guardada em disco (ex.: a imagem que a ORIGEM publicou) → manda em base64
    const ext = (args.imagem.split(".").pop() ?? "jpg").toLowerCase();
    mimetype =
      mimetype ??
      ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext] ??
      "image/jpeg";
    const lido = lerMidia(args.imagem);
    if (!lido) throw new Error("mídia local inválida");
    media = lido.base64;
    mimetype = mimetype ?? lido.mimetype;
  } else if (!/^https?:\/\//.test(args.imagem) && !args.imagem.startsWith("data:")) {
    mimetype = mimetype ?? "image/jpeg";
  }
  return comRetry(async (instance) => {
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
      signal: AbortSignal.timeout(60_000),
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
