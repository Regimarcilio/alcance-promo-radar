import { engine, enviarViaGo, type EnvioResult } from "./evolution-go.js";
import {
  avaliarInstanciaFixada,
  marcarInstanciaRuim,
  proximaInstancia,
  registrarEnvio,
  type FluxoEnvio,
} from "./rotacao.js";
import { marcarEnvioAtivo } from "../monitor/envio-lock.js";
import { classificarMidia, ehArquivoMidia, lerMidia, urlImagemSegura } from "../monitor/midia.js";

/** Dispatch abstraído (ADR-001). Roteia v2 ↔ GO via EVO_ENGINE. */
export type { EnvioResult };

/**
 * Erro de rede/conexão (vale repetir)? 5xx, "Connection Closed", socket, timeout.
 * A implementação vive em `src/wa/erros.ts` (módulo neutro) para que a camada
 * de Mensageria classifique o erro sem criar ciclo de import.
 */
export { ehErroTransitorio } from "./erros.js";
import { ehErroTransitorio } from "./erros.js";

/**
 * Repete só erros TRANSITÓRIOS (WhatsApp/Evolution cai e volta em segundos).
 * Um 500 isolado não deve custar a oferta do ciclo.
 */
async function comRetry<T>(
  fn: (instancia: string) => Promise<T>,
  fluxo?: FluxoEnvio,
  tentativas = 3,
  /**
   * Instância FIXADA pelo operador (issue #45): número escolhido na campanha
   * da aba Clientes. Válida → a primeira tentativa usa ela; inválida (caída,
   * pausada, sem permissão ou desconectada) → cai no sorteio automático com
   * aviso no log, sem travar o envio.
   */
  fixada?: string | null
): Promise<T> {
  let ultimo: any;
  const falhas: string[] = [];
  // A permissão usada na validação da fixada é a do fluxo; sem fluxo
  // informado (caminho de grupo direto) vale a permissão de Disparo.
  const fluxoPermissao: FluxoEnvio = fluxo ?? "disparo";
  for (let i = 0; i < tentativas; i++) {
    let instancia: string;
    if (i === 0 && fixada) {
      const fix = String(fixada).trim();
      const aval = await avaliarInstanciaFixada(fix, fluxoPermissao, falhas);
      if (aval.ok) {
        instancia = fix;
        console.log(`[dispatch] instância fixada ${fix} usada no fluxo ${fluxoPermissao}`);
      } else {
        console.log(
          `[dispatch] instância fixada ${fix} inválida no fluxo ${fluxoPermissao} — usando automático (${aval.motivo ?? "motivo desconhecido"})`
        );
        instancia = await proximaInstancia(fluxo, falhas);
      }
    } else {
      // cada tentativa sorteia de novo, ignorando quem acabou de falhar
      instancia = await proximaInstancia(fluxo, falhas);
    }
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
      // Instância instável (ex.: "Connection Closed" com state open) sai do
      // sorteio por 5 min: sem isso o próximo item cai nela de novo.
      marcarInstanciaRuim(instancia);
      const espera = 2000 * (i + 1); // 2s, 4s
      console.log(
        `[dispatch] erro transitório em ${instancia} (${msg.slice(0, 80)}) — repetindo em ${espera / 1000}s (${i + 2}/${tentativas})`
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
 *
 * Esta é a validação de **upload** (o arquivo tem que existir agora). No
 * envio, a checagem é `decidirMidiaEnvio` — lá o arquivo pode ter sumido.
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
  const c = classificarMidia(imagem);
  if (c.ok) return;
  throw new Error(c.erro ?? "caminho de imagem inválido");
}

/**
 * Como tratar a mídia local no **momento do envio**.
 *
 * - `usar` — arquivo válido: envia com mídia;
 * - `somente-texto` — o arquivo **sumiu** (faxina de retenção): a mídia é
 *   acessória, então envia só o texto/link. Antes isso matava a mensagem
 *   inteira com "caminho de mídia não permitido" (issue #82);
 * - `rejeitar` — violação de segurança (caminho fora de `data/midia` ou nome
 *   inválido) ou modo estrito: bloqueia o envio.
 */
export type AcaoMidiaEnvio = "usar" | "somente-texto" | "rejeitar" | "sem-midia";

export interface DecisaoMidiaEnvio {
  acao: AcaoMidiaEnvio;
  erro?: string;
}

/**
 * Modo de tratamento da mídia local ausente:
 * - `texto` (padrão): a mídia sumiu → envia **só o texto**. A oferta não pode
 *   ficar presa por causa de um acessório;
 * - `estrito`: a mídia sumiu → erro explícito (a mensagem vai para a DLQ).
 */
function modoMidiaAusente(): "texto" | "estrito" {
  return String(process.env.MENSAGERIA_MIDIA_AUSENTE ?? "texto").trim().toLowerCase() === "estrito"
    ? "estrito"
    : "texto";
}

/**
 * Decide o que fazer com a mídia no envio, separando **expiração** de
 * **segurança**. `data:` e `http(s)` seguem os caminhos antigos.
 */
export function decidirMidiaEnvio(
  arquivo: string,
  tipo: "image" | "video" | "document",
): DecisaoMidiaEnvio {
  if (!arquivo) return { acao: "sem-midia" };
  if (/^https?:\/\//i.test(arquivo)) {
    if (!urlImagemSegura(arquivo)) return { acao: "rejeitar", erro: "mídia remota recusada (URL insegura)" };
    return { acao: "usar" };
  }
  if (arquivo.startsWith("data:")) {
    const ok =
      tipo === "video"
        ? /^data:video\//i.test(arquivo)
        : tipo === "document"
          ? /^data:application\//i.test(arquivo)
          : /^data:image\//i.test(arquivo);
    return ok ? { acao: "usar" } : { acao: "rejeitar", erro: "data URI de mídia inválido" };
  }
  const c = classificarMidia(arquivo);
  if (c.ok) return { acao: "usar" };
  if (c.motivo === "inexistente") {
    if (modoMidiaAusente() === "estrito") {
      return { acao: "rejeitar", erro: c.erro ?? "arquivo de mídia não existe mais" };
    }
    return { acao: "somente-texto", erro: c.erro };
  }
  // violação de segurança: sempre bloqueia
  return { acao: "rejeitar", erro: c.erro ?? "caminho de mídia não permitido" };
}

/**
 * Mesma checagem de origem, mas ciente do tipo: vídeo/documento também passam.
 * Arquivo local continua restrito a data/midia com nome UUID.
 */
function validarMidiaArquivo(arquivo: string, tipo: "image" | "video" | "document"): void {
  if (!arquivo) return;
  const d = decidirMidiaEnvio(arquivo, tipo);
  if (d.acao === "rejeitar") throw new Error(d.erro ?? "caminho de mídia não permitido");
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
  fluxo?: FluxoEnvio;
  /** instância fixada da campanha (null/ausente = rodízio do fluxo) */
  instancia?: string | null;
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
  }, args.fluxo, 3, args.instancia ?? null);
}

export async function enviarParaGrupo(args: {
  grupo: string;
  imagem?: string;
  legenda: string;
  dryRun: boolean;
  /** fluxo de origem: filtra números por permissão/pausa (issues #36/#37). */
  fluxo?: FluxoEnvio;
  /**
   * Instância FIXADA por campanha (issue #45): número escolhido pelo
   * operador na aba Clientes. Null/ausente = rodízio do fluxo.
   */
  instancia?: string | null;
  /** "video" envia como vídeo (upload da tela Clientes); padrão imagem. */
  mediatype?: "image" | "video" | "document";
  mimetype?: string;
}): Promise<EnvioResult> {
  const imagem = String(args.imagem ?? "");
  if (engine() === "go") return enviarViaGo({ ...args, imagem });
  const evoUrl = process.env.EVO_URL;
  const evoKey = process.env.EVO_KEY;
  if (args.dryRun) {
    console.log(
      `[dry-run] grupo=${args.grupo} legenda=${args.legenda.length}chars imagem=${imagem || "(sem)"}`
    );
    return { messageId: `dryrun-${Date.now()}`, dryRun: true };
  }
  if (!evoUrl || !evoKey) {
    throw new Error("Evolution não configurada (EVO_URL/EVO_KEY) — envio abortado");
  }
  const tipo = args.mediatype ?? "image";
  // Mídia local: separa EXPIRAÇÃO (arquivo sumiu) de VIOLAÇÃO DE SEGURANÇA
  // (caminho fora de data/midia). Expiração não pode matar a mensagem: a
  // mídia é acessória e o texto/link da oferta tem valor (issue #82).
  const decisao = decidirMidiaEnvio(imagem, tipo);
  if (decisao.acao === "rejeitar") throw new Error(decisao.erro ?? "caminho de mídia não permitido");
  const midiaAusente = decisao.acao === "somente-texto";
  if (midiaAusente) {
    console.warn(
      `[dispatch] mídia local ausente (${decisao.erro}) — envio só com o texto: grupo=${args.grupo}`
    );
  }
  const temMidia =
    !midiaAusente &&
    (/^https?:\/\//.test(imagem) || imagem.startsWith("data:") || ehArquivoMidia(imagem));
  if (temMidia) {
    try {
      return await enviarMidia({ ...args, imagem, mediatype: tipo });
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
  fluxo?: FluxoEnvio;
  /** instância fixada da campanha (null/ausente = rodízio do fluxo) */
  instancia?: string | null;
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
  validarMidiaArquivo(args.imagem, args.mediatype ?? "image");
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
  }, args.fluxo, 3, args.instancia ?? null);
}
