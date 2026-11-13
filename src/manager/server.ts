import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versaoDoApp } from "../config/versao.js";
import catsJson from "../categorias.json" with { type: "json" };
import { CATEGORIAS_AMAZON } from "../amazon/amazon.js";
import { listarPublicacoes, resumoRastreio, publicacoesCsv } from "../store/publicacoes.js";
import { FiltrosSchema } from "../hunter/schema.js";
import { hunt } from "../hunter/service.js";
import { rankear } from "../scorer.js";
import type { Oportunidade } from "../hunter/schema.js";
import { completarCandidato } from "../ml/item-page.js";
import { converterLink } from "../ml/provider.js";
import { listarContas, salvarConta, definirPadrao, definirMapa, lerMapa, resolver, grupoPara } from "../ml/contas.js";
import { status as pilotoStatus, start as pilotoStart, stop as pilotoStop, ligarTudo, lerCesta, salvarCesta, limparCesta, retomarLoopsNoBoot, religar as pilotoReligar } from "../ml/piloto.js";
import { colher, lerMapaVitrine, definirMapaVitrine, folhasDescobertas } from "../ml/vitrine.js";
import { subcategoriasDe } from "../ml/hub.js";
import { gerarHeadline } from "../ai/gateway.js";
import { formatar } from "../wa/formatter.js";
import { registrarEnvio } from "../store/dedup.js";
import { enviarParaGrupo, validarImagem } from "../wa/dispatch.js";
import {
  carregarMonitor, adicionarRegra, removerDestino, removerRegra, definirAutoEnviar, definirFoto,
  alternarOrigem, alternarDestino,
} from "../monitor/grupos.js";
import { processar as processarMonitor, extrairMensagem } from "../monitor/webhook.js";
import { eventos as eventosMonitor, resumo as resumoMonitor, zerarContadores, limparDedup } from "../monitor/state.js";
import { tamanhoFila, intervaloFila, limparFila, iniciarFilaWorker, pararFilaWorker, aguardarProcessamento } from "../monitor/fila.js";
import {
  listarContatos, listarListas, criarLista, removerLista, adicionarContato, renomearContato,
  removerContato, sincronizarClientes, estadoSync, enfileirarCampanha,
  estadoFilaClientes, limparFilaClientes, iniciarClientesWorker, pararClientesWorker,
  removerItensDaFila, atualizarItensDaFila,
  pausarFilaClientes, retomarFilaClientes,
} from "../clientes/clientes.js";
import {
  listarDisparos, resumoDisparos, criarDisparo, editarDisparo, excluirDisparo,
  duplicarDisparo, type MidiaDisparo, textoComLink, registrarResultadoDisparo,
} from "../clientes/disparos.js";
import { salvarMidia, midiaDir, ehArquivoMidia } from "../monitor/midia.js";
import { itensDlq, resumoFilas } from "../messaging/filas.js";
import {
  descartarItemDlq, reprocessarItemDlq, reprocessarLoteDlq,
} from "../messaging/dlq-operacoes.js";
import { comCorrelacao } from "../messaging/envelope.js";
import { publicarEvento, estadoAssinantes, processarPendentes } from "../messaging/eventos.js";
import { lerAuditoriaAcoes, lerAuditoriaEventos } from "../messaging/consumidores.js";
import { lerTitulos, definirTitulo } from "../ui/titulos.js";
import { resolverMidia } from "./midia.js";
import { logger } from "../observability/logger.js";
import { detectar as detectarOferta, rotulo as rotuloPrograma } from "../monitor/parser.js";
import { expandirLink } from "../monitor/curtos.js";
import {
  listarGrupos, estadoConexao, contaPareada, reiniciar, desconectar, configurarWebhook,
  buscarPermissaoGrupo, definirPermissaoGrupo, gruposDoCache,
  type AcaoGrupo,
} from "../monitor/evolution.js";
import { estadoAdicao, iniciarAdicaoGrupo, pausarAdicaoGrupo, retomarAdicaoGrupo } from "../monitor/grupo-add.js";
import { enviarBoasVindas, estadoBoasVindas } from "../clientes/boas-vindas.js";
import {
  estadoSyncGrupos, iniciarSyncGruposDiario, pararSyncGruposDiario, sincronizarGruposAgora,
} from "../monitor/sync-grupos.js";
import {
  listarInstancias, estadoInstancia as estadoInstanciaWhats, adicionarInstancia, qrInstancia,
  definirAtivo as definirAtivoWhats, definirPeso, removerInstancia, MAX_INSTANCIAS,
  definirPrincipal, listarInstancias as listarInstanciasWhats, instanciaParaServico,
  definirPermissoes, definirPausado, ultimaInstanciaUsada,
  definirOverride, overrideDoFluxo, type FluxoEnvio,
} from "../wa/rotacao.js";
import {
  autenticar, auditar, checarLimite, carregarUsuarios, configurarAuth, cookieExpirado, cookieSessao,
  criarSessao, encerrarSessao, HashOcupadoError, iguais, iniciarLimpezaAuth, ipDoRequest,
  limparLimite, registrarTentativa, sessaoDoRequest, validarConfigAuth, checarLimiteReenvio, type Usuario,
} from "./auth.js";
import {
  ensureCodigoVerificacao, enviarCodigoWhatsApp, gerarCodigo, hashCodigo, mascarTelefone,
  precisaCodigo, salvarVerificacao, validarCodigo,
} from "./verificacao.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ALCANCE_DATA_DIR permite smoke/teste em diretório temporário sem tocar no estado real.
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const cacheFile = join(dataDir, "ultima-busca.json");

/** MIME aceito no upload de mídia do disparo (imagem ou vídeo). */
const MIME_UPLOAD: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
};
const MIME_ACEITO = new Set(Object.values(MIME_UPLOAD));
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Valida a mídia vinda do grid (arquivo já salvo em data/midia pelo upload).
 * Nunca confia no que o navegador manda: só aceita UUID dentro de data/midia.
 */
function midiaDoBody(m: any): MidiaDisparo | null {
  if (m === null) return null;
  if (!m || typeof m !== "object" || !m.arquivo) return null;
  const arquivo = String(m.arquivo);
  if (!ehArquivoMidia(arquivo)) throw new Error("mídia inválida — faça o upload novamente");
  const ext = extname(arquivo).toLowerCase();
  const tipo: "image" | "video" = ext === ".mp4" ? "video" : "image";
  const mime = MIME_UPLOAD[ext] ?? String(m.mime ?? "image/jpeg");
  if (!MIME_ACEITO.has(mime)) throw new Error("formato de mídia não suportado");
  return { arquivo, mime, tipo, nome: m.nome ? String(m.nome).slice(0, 120) : undefined };
}

const CATS = catsJson as { id: string; name: string }[];
const CATS_AMAZON = CATEGORIAS_AMAZON;
const PORT = Number(process.env.MANAGER_PORT ?? 8091);
const HOST = process.env.HOST ?? "127.0.0.1";

configurarAuth(dataDir);
try {
  validarConfigAuth();
} catch (e: any) {
  console.error("[auth] " + String(e?.message ?? e));
  process.exit(1);
}
if ((process.env.WEBHOOK_KEY?.trim() ?? "").length < 16) {
  console.error(
    "[auth] WEBHOOK_KEY ausente/curto (<16). O webhook ficaria aberto; configure no .env.",
  );
  process.exit(1);
}
iniciarLimpezaAuth();

// Login lido de src/ (o Dockerfile copia src; tsc não copia HTML para dist).
const LOGIN_HTML = readFileSync(join(root, "src", "manager", "login.html"), "utf8");

function salvarBusca(items: Oportunidade[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ data: new Date().toISOString(), items }, null, 2));
}

function lerBusca(): Oportunidade[] {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8")).items ?? [];
  } catch {
    return [];
  }
}

let cacheGrupos: { em: number; dados: any[] } | null = null;

const server = createServer((req, res) => {
  req.setTimeout?.(30_000);
  const reqId = randomUUID();
  const inicio = Date.now();
  res.setHeader("X-Request-Id", reqId);
  void atender(req, res, reqId, inicio).catch((e: any) => {
    logger.error({ reqId, err: String(e?.stack ?? e?.message ?? e) }, "erro não tratado");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ erro: "falha interna", requestId: reqId }));
    } else {
      res.end();
    }
  });
});

async function atender(req: any, res: any, reqId: string, inicio: number): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const metodo = req.method ?? "GET";
  res.on("finish", () => {
    if (metodo === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) return;
    logger.info(
      { reqId, metodo, rota: url.pathname, status: res.statusCode, ms: Date.now() - inicio },
      "http",
    );
  });
  const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(obj));
  };
  const html = (code: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(body);
  };

  // Cabeçalhos de segurança em toda resposta (inclusive login/redirect).
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  );

  const caminho = url.pathname;
  const ip = ipDoRequest(req);
  const ua = String(req.headers["user-agent"] ?? "");
  const ehWebhook = caminho === "/api/webhook/evolution";

  // ---------- health (público, sem detalhes sensíveis) ----------
  if (metodo === "GET" && caminho === "/healthz") {
    json(200, { ok: true, uptime: Math.floor(process.uptime()), versao: versaoDoApp() });
    return;
  }
  if (metodo === "GET" && caminho === "/readyz") {
    try {
      accessSync(dataDir, fsConstants.W_OK);
      json(200, { ok: true, dataDir: "writable" });
    } catch {
      json(503, { ok: false, erro: "data dir não gravável" });
    }
    return;
  }

  // ---------- metrics (público, sem detalhes sensíveis) ----------
  if (metodo === "GET" && caminho === "/metrics") {
    const { exportarMetricas } = await import("../monitor/metrics.js");
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(exportarMetricas());
    return;
  }

  // ---------- mídia de disparo (preview de imagem/vídeo do upload) ----------
  // Serve SOMENTE arquivos de data/midia com nome UUID, com sessão obrigatória.
  // Suporta Range para o <video> conseguir buscar/arrastar sem baixar 16 MB.
  if ((metodo === "GET" || metodo === "HEAD") && caminho.startsWith("/media/")) {
    if (!sessaoDoRequest(req)) {
      json(401, { erro: "não autenticado" });
      return;
    }
    let nome = "";
    try {
      nome = decodeURIComponent(caminho.slice("/media/".length));
    } catch {
      json(400, { erro: "caminho inválido" });
      return;
    }
    const alvo = join(midiaDir, nome);
    if (!ehArquivoMidia(alvo)) {
      json(404, { erro: "não encontrado" });
      return;
    }
    const mime = MIME_UPLOAD[extname(nome).toLowerCase()] ?? "application/octet-stream";
    try {
      const total = statSync(alvo).size;
      const range = String(req.headers.range ?? "");
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const ini = m[1] ? Number(m[1]) : 0;
        const fim = m[2] ? Math.min(Number(m[2]), total - 1) : Math.min(ini + 2_000_000, total - 1);
        if (!Number.isFinite(ini) || ini >= total || fim < ini) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": mime,
          "Content-Length": String(fim - ini + 1),
          "Content-Range": `bytes ${ini}-${fim}/${total}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=30",
        });
        createReadStream(alvo, { start: ini, end: fim }).pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=30",
      });
      if (metodo === "HEAD") {
        res.end();
        return;
      }
      createReadStream(alvo).pipe(res);
    } catch {
      json(404, { erro: "não encontrado" });
    }
    return;
  }

  // ---------- mídia estática (preview de imagens do painel) ----------
  // Serve SOMENTE imagens de /image/ (marca) e /data/ (upload do usuário),
  // com sessão obrigatória, sem subdiretórios e sem path traversal.
  if ((metodo === "GET" || metodo === "HEAD") && (caminho.startsWith("/image/") || caminho.startsWith("/data/"))) {
    if (!sessaoDoRequest(req)) {
      json(401, { erro: "não autenticado" });
      return;
    }
    const ehData = caminho.startsWith("/data/");
    const base = ehData ? dataDir : join(root, "image");
    const prefixo = ehData ? "/data/" : "/image/";
    let nome = "";
    try {
      nome = decodeURIComponent(caminho.slice(prefixo.length));
    } catch {
      json(400, { erro: "caminho inválido" });
      return;
    }
    const midia = resolverMidia(base, nome);
    if (!midia.ok) {
      json(404, { erro: "não encontrado" });
      return;
    }
    try {
      const buf = readFileSync(midia.alvo);
      res.writeHead(200, {
        "Content-Type": midia.mime,
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "private, max-age=30",
      });
      res.end(metodo === "HEAD" ? undefined : buf);
    } catch {
      json(404, { erro: "não encontrado" });
    }
    return;
  }

  // CSRF de borda: navegador manda Origin; exige mesmo host. Webhook é S2S.
  if (metodo !== "GET" && !ehWebhook && !origemPermitida(req)) {
    auditar("origem_invalida", { ip, ua, detalhe: caminho });
    json(403, { erro: "origem inválida" });
    return;
  }

  // ---------- rotas públicas ----------
  if (metodo === "GET" && (caminho === "/" || caminho === "/login")) {
    const sessao = sessaoDoRequest(req);
    if (caminho === "/login") {
      if (sessao) {
        res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      html(200, LOGIN_HTML);
      return;
    }
    if (!sessao) {
      res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    html(200, PAGINA);
    return;
  }

  if (metodo === "POST" && caminho === "/api/auth/login") {
    const limite = checarLimite(ip);
    if (!limite.ok) {
      auditar("rate_limited", { ip, ua });
      json(429, { erro: "Muitas tentativas. Aguarde e tente novamente." }, {
        "Retry-After": String(limite.retryAfter),
      });
      return;
    }
    let corpo: any;
    try {
      const tipo = String(req.headers["content-type"] ?? "");
      if (!tipo.toLowerCase().includes("application/json")) {
        json(415, { erro: "content-type deve ser application/json" });
        return;
      }
      corpo = JSON.parse(await lerCorpo(req, 64 * 1024));
    } catch {
      json(400, { erro: "corpo inválido" });
      return;
    }
    const nome = typeof corpo?.usuario === "string" ? corpo.usuario.trim() : "";
    const senha = typeof corpo?.senha === "string" ? corpo.senha : "";
    if (!nome || !senha) {
      json(400, { erro: "informe usuário e senha" });
      return;
    }
    if (nome.length > 256 || senha.length > 1024) {
      json(400, { erro: "credenciais inválidas" });
      return;
    }
    registrarTentativa(ip);
    let usuario: Usuario | null = null;
    try {
      usuario = await autenticar(nome, senha);
    } catch (e) {
      if (e instanceof HashOcupadoError) {
        json(503, { erro: "Sistema ocupado. Tente em instantes." }, { "Retry-After": "1" });
        return;
      }
      throw e;
    }
    if (!usuario) {
      auditar("login_falha", { usuario: nome, ip, ua });
      json(401, { erro: "usuário ou senha inválidos" });
      return;
    }

    // ---------- verificação de celular (2FA de primeiro uso) ----------
    // Usuário com WhatsApp cadastrado e celular ainda não confirmado precisa do
    // código de 10 posições que foi enviado para o celular dele.
    if (precisaCodigo(usuario)) {
      const codigoInformado = typeof corpo?.codigo === "string" ? corpo.codigo.trim() : "";
      if (!codigoInformado) {
        // ainda sem código: reenvia (ou reusa) e devolve o pedido
        const r = await ensureCodigoVerificacao(usuario, dataDir);
        json(200, {
          ok: false,
          precisaCodigo: true,
          telefone: mascarTelefone(usuario.telefone ?? ""),
          enviado: r.enviado,
          // sem erro = o código do cadastro continua valendo (não precisa reenviar)
          erro: r.erro ? `não foi possível enviar o código: ${r.erro}` : undefined,
        });
        return;
      }
      const v = validarCodigo(usuario, codigoInformado, dataDir);
      if (!v.ok) {
        auditar("codigo_invalido", { usuario: usuario.usuario, ip, ua, detalhe: v.motivo });
        const msgs: Record<string, string> = {
          invalido: "código inválido",
          expirado: "código expirado — peça um novo",
          tentativas: "demasiadas tentativas — peça um novo código",
          sem_codigo: "código não encontrado — peça um novo",
        };
        json(401, { erro: msgs[v.motivo] ?? "código inválido", precisaCodigo: true });
        return;
      }
      // recarrega o usuário (verificação gravada)
      const recarregado = carregarUsuarios().find((u) => u.id === usuario!.id);
      if (recarregado) usuario = recarregado;
    }

    limparLimite(ip);
    const sessao = criarSessao(usuario, ip, ua);
    auditar("login_ok", { usuario: usuario.usuario, ip, ua });
    json(200, {
      ok: true,
      usuario: { nome: usuario.usuario, papel: usuario.papel },
    }, { "Set-Cookie": cookieSessao(sessao.valor, sessao.maxAge) });
    return;
  }

  if (metodo === "POST" && caminho === "/api/auth/reenviar-codigo") {
    // Reenvia o código de verificação (celular ainda não confirmado).
    // Anti-abuso: rate-limit dedicado, resposta uniforme (não revela usuário
    // nem telefone) e sem resetar o lockout de tentativas.
    const limite = checarLimiteReenvio(ip);
    if (!limite.ok) {
      auditar("reenvio_limited", { ip, ua });
      json(429, { ok: true }, { "Retry-After": String(limite.retryAfter) });
      return;
    }
    const tipo = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!tipo.includes("application/json")) {
      json(415, { ok: true });
      return;
    }
    try {
      const corpo = JSON.parse(await lerCorpo(req, 4 * 1024));
      const nome = String(corpo?.usuario ?? "").trim();
      const u = carregarUsuarios().find(
        (x) => x.usuario.toLowerCase() === nome.toLowerCase() && !x.desativado
      );
      if (u && precisaCodigo(u)) {
        const r = await ensureCodigoVerificacao(u, dataDir, true);
        auditar("codigo_reenviado", { usuario: u.usuario, ip, ua, detalhe: r.enviado ? "enviado" : `falhou: ${r.erro ?? "?"}` });
      }
      json(200, { ok: true }); // resposta uniforme: não enumera usuários/telefones
    } catch {
      json(200, { ok: true });
    }
    return;
  }

  if (metodo === "POST" && caminho === "/api/auth/logout") {
    const sessao = sessaoDoRequest(req);
    if (sessao) {
      encerrarSessao(sessao.sid);
      auditar("logout", { usuario: sessao.usuario.usuario, ip, ua });
    }
    json(200, { ok: true }, { "Set-Cookie": cookieExpirado() });
    return;
  }

  if (metodo === "GET" && caminho === "/api/auth/me") {
    const sessao = sessaoDoRequest(req);
    if (!sessao) {
      json(401, { erro: "não autenticado" });
      return;
    }
    json(200, { usuario: { nome: sessao.usuario.usuario, papel: sessao.usuario.papel } });
    return;
  }

  // ---------- gate default-deny ----------
  // Webhook continua fora (autentica por WEBHOOK_KEY na própria rota).
  // MANAGER_KEY vira credencial de máquina opcional para /api/*.
  const sessao = sessaoDoRequest(req);
  const mkey = process.env.MANAGER_KEY?.trim() || "";
  const headerMkey = req.headers["x-manager-key"];
  const chaveMaquina = !!mkey && typeof headerMkey === "string" && iguais(headerMkey, mkey);
  if (!ehWebhook && !sessao && !(caminho.startsWith("/api/") && chaveMaquina)) {
    if (caminho.startsWith("/api/")) {
      json(401, { erro: "não autenticado" });
    } else {
      json(404, { erro: "rota?" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/categorias") {
    // ?programa=amazon devolve as categorias da Amazon (mesmo formato).
    const prog = url.searchParams.get("programa") ?? "ml";
    if (prog === "amazon") {
      json(200, CATS_AMAZON.map((c) => ({ id: c.id, name: c.nome })));
      return;
    }
    json(200, CATS);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/amazon/status") {
    // O que falta para a caça Amazon funcionar (credenciais + tag de comissão).
    const { credenciaisAmazon } = await import("../monitor/amazon-api.js");
    const { tagAmazon } = await import("../amazon/amazon.js");
    json(200, {
      credenciais: !!credenciaisAmazon(),
      tag: !!tagAmazon(),
      categorias: CATS_AMAZON.length,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/rastreio") {
    // Publicações registradas (Piloto + Monitor) com filtros e CSV.
    const dias = Number(url.searchParams.get("dias") ?? 0);
    const f = {
      programa: url.searchParams.get("programa") || undefined,
      categoria: url.searchParams.get("categoria") || undefined,
      grupo: url.searchParams.get("grupo") || undefined,
      via: url.searchParams.get("via") || undefined,
      dias: dias > 0 ? dias : undefined,
    };
    if (url.searchParams.get("csv") === "1") {
      const csv = publicacoesCsv(f);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="rastreio-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.end("﻿" + csv); // BOM: Excel pt-BR abre acentos certo
      return;
    }
    json(200, { ...resumoRastreio(f), publicacoes: listarPublicacoes(f).slice(0, 300) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/piloto") {
    json(200, pilotoStatus());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/piloto/start") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const loop = pilotoStart(
        { conta: b.conta ?? "", category: b.category ?? "", grupo: b.grupo ?? "", sub: b.sub ?? "", qtd: b.qtd ?? 2, intervaloS: b.intervaloS ?? 60, filtro: String(b.filtro ?? "").trim(), minMin: 5, maxMin: 5, programa: b.programa === "amazon" ? "amazon" : "ml" },
        true
      );
      json(200, { ok: true, loop, ...pilotoStatus() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/piloto/religar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const loop = pilotoReligar(Number(b.id ?? 0));
      json(200, { ok: true, loop, ...pilotoStatus() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/piloto/stop") {
    try {
      let b: any = {};
      try {
        b = JSON.parse(await lerCorpo(req));
      } catch {
        /* sem corpo = para tudo */
      }
      pilotoStop(typeof b.id === "number" ? b.id : undefined);
      json(200, { ok: true, ...pilotoStatus() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/auto/ligar") {
    // TUDO AUTOMÁTICO: liga um loop por categoria amarrada (conta+grupo do mapa).
    try {
      const r = ligarTudo();
      json(200, { ok: true, ...r, ...pilotoStatus() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/cesta") {
    const category = url.searchParams.get("category") ?? "";
    json(200, { category, items: lerCesta(category) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/cesta") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const urls: string[] = Array.isArray(b.urls) ? b.urls : String(b.texto ?? "").split(/\r?\n/);
      const r = salvarCesta(b.category ?? "", urls);
      json(200, { ok: true, novos: r.novos, atualizados: r.atualizados, items: lerCesta(b.category ?? "") });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/cesta/limpar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      limparCesta(b.category ?? "");
      json(200, { ok: true, items: [] });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/buscar") {
    try {
      const f = FiltrosSchema.parse({
        category: url.searchParams.get("category") ?? "MLB3937",
        q: url.searchParams.get("q") ?? "",
        descontoMin: Number(url.searchParams.get("descontoMin") ?? 30),
        teto: Number(url.searchParams.get("teto") ?? 500),
        limite: Number(url.searchParams.get("limite") ?? 6),
      });
      const corte = Number(url.searchParams.get("corte") ?? 0);
      const { url: fonte, candidatos, mock } = await hunt(f);
      const items = rankear(candidatos, corte, f.descontoMin).slice(0, f.limite);
      salvarBusca(items);
      json(200, { mock, fonte, total: candidatos.length, items });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/enviar") {
    try {
      const body = JSON.parse(await lerCorpo(req));
      const item = lerBusca().find((o) => o.mlbId === body.mlbId);
      if (!item) return json(404, { erro: "Rode Buscar antes de enviar (item fora da última busca)." });
      const dry = body.dry === true;
      const catName = CATS.find((c) => c.id === (body.category ?? ""))?.name ?? "Oferta";
      const completo = {
        ...(await completarCandidato(item)),
        descontoPct: item.descontoPct,
        score: item.score,
        motivo: item.motivo,
        selo: item.selo,
      };
      const enrich = await converterLink(completo.link, { conta: body.conta, category: body.category });
      const { headline, subtitulo } = gerarHeadline(completo);
      const mensagem = formatar({
        headline, subtitulo, nome: completo.titulo, precoDe: completo.precoDe,
        precoPix: completo.precoAtual, cupom: completo.cupom, link: enrich.linkAfiliado,
        categoria: `${catName}${body.q ? ` • "${body.q}"` : ""}`, score: completo.score,
      });
      validarImagem(completo.imagem);
      const r = await enviarParaGrupo({
        grupo: grupoPara(body.category, body.grupo),
        imagem: completo.imagem, legenda: mensagem, dryRun: dry,
      });
      if (!dry) registrarEnvio(completo.mlbId, completo.precoAtual, completo.cupom);
      json(200, {
        ok: true, messageId: r.messageId, dryRun: r.dryRun,
        link: enrich.linkAfiliado, comFoto: /^https?:\/\//.test(completo.imagem),
        comissao: enrich.fonte === "conversor", aviso: enrich.aviso ?? null, conta: enrich.conta ?? null,
        grupo: grupoPara(body.category, body.grupo),
        titulo: completo.titulo, mensagem,
      });
    } catch (e: any) {
      logger.error({ reqId, err: String(e?.stack ?? e) }, "erro na rota");
      json(500, { erro: "falha interna", requestId: reqId });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/contas") {
    try {
      json(200, { contas: listarContas(), mapa: lerMapa() });
    } catch (e: any) {
      logger.error({ reqId, err: String(e?.stack ?? e) }, "erro na rota");
      json(500, { erro: "falha interna", requestId: reqId });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/contas") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      if (b.acao === "padrao") definirPadrao(b.nome);
      else salvarConta(b.nome ?? "", b.tag ?? "", b.cookie ?? "");
      json(200, { ok: true, contas: listarContas() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/mapa") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirMapa(b.category ?? "", b.conta ?? "-", b.grupo ?? "", b.sub ?? "");
      json(200, { ok: true, mapa: lerMapa() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/subcategorias") {
    // Subcategorias disponíveis numa categoria (informado pelo próprio hub).
    try {
      const category = url.searchParams.get("category") ?? "";
      if (!category) return json(400, { erro: "category obrigatória" });
      json(200, { category, items: await subcategoriasDe(category) });
    } catch (e: any) {
      json(200, { category: url.searchParams.get("category") ?? "", items: [], aviso: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/grupos") {
    // Grupos reais do WhatsApp pareado (para amarrar categoria → grupo).
    // MESMA fonte do /api/monitor/whats-grupos (listarGrupos): assim há um
    // único cache em memória + o cache em disco (data/grupos-cache.json),
    // que é refrescado a cada sucesso.
    const refresh = url.searchParams.get("refresh") === "1";
    const t0 = Date.now();
    try {
      const dados = await listarGrupos(refresh);
      cacheGrupos = { em: Date.now(), dados: dados.map((g) => ({ id: g.jid, nome: g.nome, tamanho: g.tamanho })) };
      json(200, { grupos: cacheGrupos.dados });
    } catch (e: any) {
      // Fallback: última lista salva em disco (Evolution lenta/limitada/fora).
      const salvo = gruposDoCache();
      const lista = cacheGrupos?.dados ?? salvo.grupos.map((g) => ({ id: g.jid, nome: g.nome, tamanho: g.tamanho }));
      const idadeMin = salvo.em ? Math.round((Date.now() - new Date(salvo.em).getTime()) / 60000) : null;
      json(200, {
        grupos: lista,
        aviso: lista.length
          ? `Evolution ${String(e?.message ?? e).includes("aborted") ? "demorou demais" : "inacessível"} — mostrando a última lista salva${idadeMin != null ? ` (de ${idadeMin} min atrás)` : ""}`
          : `Evolution inacessível: ${String(e?.message ?? e)}`,
        deCache: true,
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/grupos/permissao") {
    // Permissões atuais do grupo (announce = só admins falam; restrict = só admins editam).
    const grupoJid = String(url.searchParams.get("grupoJid") ?? "");
    const p = await buscarPermissaoGrupo(grupoJid);
    if (!p) {
      json(404, { erro: "grupo não encontrado (ou Evolution inacessível)" });
      return;
    }
    json(200, { ok: true, ...p });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/grupos/permissao") {
    // Aplica permissão no grupo: announcement (só admins falam) / locked (só admins editam) etc.
    try {
      const b = JSON.parse(await lerCorpo(req));
      const grupoJid = String(b.grupoJid ?? "");
      const acao = String(b.acao ?? "") as AcaoGrupo;
      const permitidas: AcaoGrupo[] = ["announcement", "not_announcement", "locked", "unlocked"];
      if (!permitidas.includes(acao)) {
        json(400, { erro: `ação inválida (use ${permitidas.join("|")})` });
        return;
      }
      const r = await definirPermissaoGrupo(grupoJid, acao);
      const p = r.ok ? await buscarPermissaoGrupo(grupoJid) : null;
      json(r.ok ? 200 : 502, { ok: r.ok, erro: r.erro, permissao: p });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/vitrine") {
    // Vitrine real do perfil social: produtos com preço+foto, sem bloqueio.
    try {
      const items = await colher();
      json(200, { ok: true, total: items.length, folhas: folhasDescobertas(items), mapa: lerMapaVitrine(), items: items.slice(0, 12) });
    } catch (e: any) {
      json(200, { ok: false, erro: String(e.message ?? e), folhas: [], mapa: lerMapaVitrine(), items: [] });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/vitrine/map") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirMapaVitrine(b.leaf ?? "", b.category ?? "");
      json(200, { ok: true, mapa: lerMapaVitrine() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/cupons") {
    // Cupons ML por categoria + códigos registrados (digitáveis, estilo Emipe).
    try {
      const { colherCupons, lerRegistro } = await import("../ml/cupons.js");
      const todos = await colherCupons().catch(() => []);
      const category = url.searchParams.get("category") ?? "";
      const conta = url.searchParams.get("conta") ?? "";
      const { codigoPara } = await import("../ml/cupons.js");
      json(200, {
        registrados: lerRegistro(),
        paraCategoria: category
          ? todos.filter((c) => c.cats.includes(category)).slice(0, 6)
          : [],
        codigo: category ? codigoPara(category, conta || undefined) : null,
      });
    } catch (e: any) {
      json(200, { registrados: {}, paraCategoria: [], codigo: null });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/cupons") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const { salvarRegistro, lerRegistro } = await import("../ml/cupons.js");
      salvarRegistro(b.chave ?? "", b.codigo ?? "", b.nome ?? "");
      json(200, { ok: true, registrados: lerRegistro() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/colar") {
    // Fluxo REAL: cola URL do produto → link com SUA comissão + enrich (auto ou manual).
    try {
      const body = JSON.parse(await lerCorpo(req));
      const urlProduto: string = (body.url ?? "").trim();
      if (!/^https?:\/\//.test(urlProduto)) return json(400, { erro: "Cole a URL completa do produto." });
      const { gerarLinkAfiliado } = await import("../ml/affiliate.js");
      const { enrichItem } = await import("../ml/item-page.js");
      const contaNome: string | undefined = body.conta || undefined;
      const category: string | undefined = body.category || undefined;
      let link: string | null = null;
      let tagOk = false;
      let searchCode: string | null = null;
      let avisoLink: string | null = null;
      let contaUsada: string | null = null;
      try {
        const c = resolver(category, contaNome);
        contaUsada = c.nome;
        const r = await gerarLinkAfiliado(urlProduto, { tag: c.tag, cookie: c.cookie });
        link = r.shortUrl;
        tagOk = r.tagOk;
        searchCode = r.searchCode;
        if (!tagOk) avisoLink = "TAG_DIVERGENTE: confira sua etiqueta.";
      } catch (e: any) {
        avisoLink = `Falha (${e.message}) — sem conta? Cadastre na tela Contas.`;
      }
      const auto = await enrichItem(urlProduto);
      json(200, {
        ok: true, link, tagOk, searchCode, avisoLink, conta: contaUsada,
        auto: auto ? { titulo: auto.titulo, imagem: auto.imagem, precoAtual: auto.precoAtual, precoDe: auto.precoDe, vendidos: auto.vendidos } : null,
        autoOk: !!auto,
      });
    } catch (e: any) {
      logger.error({ reqId, err: String(e?.stack ?? e) }, "erro na rota");
      json(500, { erro: "falha interna", requestId: reqId });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/enviar-direto") {
    // Envio com dados confirmados na tela (reais) + foto real.
    try {
      const b = JSON.parse(await lerCorpo(req));
      const dry = b.dry === true;
      for (const k of ["titulo", "precoPix", "link"]) {
        if (!b[k]) return json(400, { erro: `Campo obrigatório: ${k}` });
      }
      const { gerarHeadline } = await import("../ai/gateway.js");
      const fake = {
        mlbId: b.mlbId ?? "COLADO", titulo: b.titulo, imagem: b.imagem ?? "",
        precoDe: b.precoDe ?? null, precoAtual: Number(b.precoPix),
        cupom: b.cupom ?? null, vendidos: Number(b.vendidos ?? 0), avaliacao: 0, link: b.link,
      };
      const { headline, subtitulo } = gerarHeadline({ ...fake, descontoPct: 0, score: 80, motivo: "curadoria manual", selo: "OFERTA BOA" } as any);
      const mensagem = formatar({
        headline: b.headline || headline, subtitulo: "caiu muito o preço",
        nome: fake.titulo, precoDe: fake.precoDe, precoPix: fake.precoAtual,
        precoParc: b.precoParc ? Number(b.precoParc) : undefined,
        cupom: fake.cupom, link: fake.link, categoria: "Curadoria", score: 80,
      });
      validarImagem(fake.imagem);
      const r = await enviarParaGrupo({
        grupo: grupoPara(b.category, b.grupo),
        imagem: fake.imagem, legenda: mensagem, dryRun: dry,
      });
      json(200, {
        ok: true, messageId: r.messageId, dryRun: r.dryRun,
        link: fake.link, comFoto: /^https?:\/\//.test(fake.imagem), mensagem,
        grupo: grupoPara(b.category, b.grupo),
      });
    } catch (e: any) {
      logger.error({ reqId, err: String(e?.stack ?? e) }, "erro na rota");
      json(500, { erro: "falha interna", requestId: reqId });
    }
    return;
  }
  // ---------- E6 MONITOR ----------
  if (req.method === "GET" && url.pathname === "/api/instancias") {
    const ultima = ultimaInstanciaUsada();
    const itens = await Promise.all(
      listarInstancias().map(async (i) => ({
        ...i,
        estado: await estadoInstanciaWhats(i.instancia),
        emUso: ultima === i.instancia,
      }))
    );
    json(200, {
      max: MAX_INSTANCIAS,
      itens,
      overrides: {
        piloto: overrideDoFluxo("piloto"),
        monitor: overrideDoFluxo("monitor"),
        disparo: overrideDoFluxo("disparo"),
      },
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: true, ...(await adicionarInstancia(String(b.nome ?? ""))) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/qr") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: true, qr: await qrInstancia(String(b.instancia ?? "")) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/ativo") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirAtivoWhats(String(b.instancia ?? ""), b.ativo === true);
      json(200, { ok: true });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/principal") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirPrincipal(String(b.instancia ?? ""), b.principal !== false);
      json(200, { ok: true, instancias: listarInstanciasWhats().map((i) => ({ instancia: i.instancia, principal: !!i.principal })) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/peso") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirPeso(String(b.instancia ?? ""), Number(b.peso));
      json(200, { ok: true });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/permissoes") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirPermissoes(String(b.instancia ?? ""), {
        piloto: typeof b.piloto === "boolean" ? b.piloto : undefined,
        monitor: typeof b.monitor === "boolean" ? b.monitor : undefined,
        disparo: typeof b.disparo === "boolean" ? b.disparo : undefined,
      });
      json(200, { ok: true });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/pausar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirPausado(String(b.instancia ?? ""), b.pausado === true);
      json(200, { ok: true });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/override") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const fluxo = String(b.fluxo ?? "");
      if (fluxo !== "piloto" && fluxo !== "monitor" && fluxo !== "disparo") {
        throw new Error("fluxo inválido (use piloto, monitor ou disparo)");
      }
      const valor =
        b.valor === null || b.valor === undefined || b.valor === "" ? null : String(b.valor);
      definirOverride(String(b.instancia ?? ""), fluxo as FluxoEnvio, valor);
      json(200, {
        ok: true,
        overrides: {
          piloto: overrideDoFluxo("piloto"),
          monitor: overrideDoFluxo("monitor"),
          disparo: overrideDoFluxo("disparo"),
        },
      });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/instancias/remover") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      await removerInstancia(String(b.instancia ?? ""));
      json(200, { ok: true });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  // ---------------- CLIENTES ----------------
  if (req.method === "GET" && url.pathname === "/api/ui") {
    json(200, { titulos: lerTitulos() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/ui/titulo") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: true, titulos: definirTitulo(String(b.chave ?? ""), String(b.titulo ?? "")) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/clientes") {
    json(200, {
      contatos: listarContatos(), listas: listarListas(), sync: estadoSync(), fila: estadoFilaClientes(),
      disparos: listarDisparos(), disparosResumo: resumoDisparos(),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/sync") {
    // roda em background; a UI acompanha por GET /api/clientes
    sincronizarClientes().catch((e) => console.log(`[clientes] sync falhou: ${String(e?.message ?? e)}`));
    json(200, { ok: true, sync: estadoSync() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/contato") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: true, contato: adicionarContato(String(b.nome ?? ""), String(b.telefone ?? "")) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/contato/renomear") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const ok = renomearContato(String(b.jid ?? ""), String(b.nome ?? ""));
      json(ok ? 200 : 404, ok ? { ok: true } : { erro: "contato não encontrado" });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/contato/remover") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: removerContato(String(b.jid ?? "")) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/lista") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: true, lista: criarLista(String(b.nome ?? ""), Array.isArray(b.contatos) ? b.contatos : []) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/lista/remover") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      json(200, { ok: removerLista(String(b.id ?? "")) });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/clientes/grupo/status") {
    json(200, { ok: true, job: estadoAdicao() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/clientes/boas-vindas/status") {
    json(200, { ok: true, ...estadoBoasVindas() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/boas-vindas/config") {
    // Salva configuração de legenda e imagem override para adição ao grupo
    try {
      const b = JSON.parse(await lerCorpo(req));
      const legenda = typeof b.legenda === "string" ? b.legenda.trim() : "";
      const imagem = typeof b.imagem === "string" ? b.imagem.trim() : "";
      // Validação simples
      if(legenda && legenda.length > 1024){
        json(400, { ok: false, erro: "legenda acima de 1024 caracteres" });
        return;
      }
      json(200, { ok: true, legenda, imagem: imagem || undefined });
    } catch (e: any) {
      json(400, { ok: false, erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/boas-vindas") {
    // Teste manual: manda a DM de boas-vindas para um número (força o reenvio).
    try {
      const b = JSON.parse(await lerCorpo(req));
      const r = await enviarBoasVindas(String(b.numero ?? ""), { forcar: b.forcar !== false });
      json(r.ok ? 200 : 400, { ...r });
    } catch (e: any) {
      json(400, { ok: false, erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/boas-vindas/upload") {
    // Upload de imagem personalizada para boas-vindas (base64 ou multipart)
    try {
      const ct = req.headers.get("content-type") || "";
      let caminho: string | null = null;
      const extOK = new Set([".png", ".jpg", ".jpeg", ".webp"]);
      
      if (ct.includes("application/json")) {
        const b = JSON.parse(await lerCorpo(req));
        if (typeof b.base64 === "string" && typeof b.filename === "string") {
          const ext = extname(b.filename).toLowerCase();
          if (!extOK.has(ext)) {
            json(400, { ok: false, erro: "formato de imagem não suportado" });
            return;
          }
          // Remove header base64 se houver
          const b64 = b.base64.replace(/^data:image\/[a-z+;]+;base64,/, "");
          const buf = Buffer.from(b64, "base64");
          const dataDir = join(dirname(fileURLToPath(import.meta.url)), "../../data");
          mkdirSync(dataDir, { recursive: true });
          const filePath = join(dataDir, "bw-custom.png");
          writeFileSync(filePath, buf);
          caminho = "data/bw-custom.png";
        }
      } else if (ct.includes("multipart")) {
        // Multipart/form-data - não implementado ainda
        json(400, { ok: false, erro: "multipart não suportado, use JSON com base64" });
        return;
      }
      
      if (!caminho) {
        json(400, { ok: false, erro: "imagem não fornecida" });
        return;
      }
      
      json(200, { ok: true, caminho });
    } catch (e: any) {
      json(500, { ok: false, erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/api/clientes/boas-vindas/upload") {
    // Remove imagem customizada
    try {
      const dataDir = join(dirname(fileURLToPath(import.meta.url)), "../../data");
      const filePath = join(dataDir, "bw-custom.png");
      if (existsSync(filePath)) {
        rmSync(filePath);
        json(200, { ok: true });
      } else {
        json(200, { ok: true, msg: "sem imagem customizada" });
      }
    } catch (e: any) {
      json(500, { ok: false, erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/grupo") {
    // Adiciona os contatos selecionados como participantes de um grupo
    // (Evolution updateParticipant action=add). Exige conta ADMIN + link de
    // convite habilitado no grupo; erro da API é devolvido sem quebrar a UI.
    try {
      const b = JSON.parse(await lerCorpo(req));
      const grupoJid = String(b.grupoJid ?? "");
      const jids = Array.isArray(b.jids) ? b.jids.map((j: unknown) => String(j)) : [];
      if (!grupoJid.endsWith("@g.us")) {
        json(400, { erro: "grupo inválido" });
        return;
      }
      if (!jids.length) {
        json(400, { erro: "nenhum contato selecionado" });
        return;
      }
      const escolhidos = listarContatos().filter((c) => jids.includes(c.jid));
      const numeros = escolhidos.map((c) => c.jid.split("@")[0]);
      if (!numeros.length) {
        json(400, { erro: "contatos não encontrados (rode 'Puxar contatos' de novo)" });
        return;
      }
      // Legenda opcional: se fornecida, cada contato recém-adicionado recebe
      // essa mensagem (com marshalling {%nome%}) logo após entrar no grupo.
      let legendaOverride: { legenda?: string; imagem?: string } = {};
      if (b.legendaOverride && typeof b.legendaOverride === "object") {
        if (typeof b.legendaOverride.legenda === "string") {
          legendaOverride.legenda = b.legendaOverride.legenda.trim();
        }
        if (typeof b.legendaOverride.imagem === "string" && b.legendaOverride.imagem.trim()) {
          legendaOverride.imagem = b.legendaOverride.imagem.trim();
        }
      }
      // Job em BACKGROUND: cada adição pode levar até 60s quando o WhatsApp
      // limita (rate-overlimit) — travar o request deixaria a tela pendurada.
      const opts = Object.keys(legendaOverride).length ? { legendaOverride } : {};
      const job = iniciarAdicaoGrupo(grupoJid, numeros, opts);
      json(200, { ok: true, job, ...estadoAdicao() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/grupo/pausar") {
    // PAUSA: cancela a continuação do job de adição a grupos
    const ok = pausarAdicaoGrupo();
    json(200, { ok, job: estadoAdicao() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/grupo/retomar") {
    // RETOMA: retoma um job pausado
    const ok = retomarAdicaoGrupo();
    json(200, { ok, job: estadoAdicao() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/enviar") {
    try {
      const b = JSON.parse(await lerCorpo(req, 8 * 1024 * 1024));
      const imagem = String(b.imagem ?? "");
      if (imagem) validarImagem(imagem);
      const pendentes = await enfileirarCampanha({
        texto: String(b.texto ?? ""),
        imagem,
        jids: Array.isArray(b.jids) ? b.jids.map(String) : [],
      });
      json(200, { ok: true, fila: estadoFilaClientes(), pendentes });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/fila/limpar") {
    json(200, { ok: true, removidos: await limparFilaClientes(), fila: estadoFilaClientes() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/fila/pausar") {
    pausarFilaClientes();
    json(200, { ok: true, fila: estadoFilaClientes() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/fila/retomar") {
    retomarFilaClientes();
    json(200, { ok: true, fila: estadoFilaClientes() });
    return;
  }
  // ---------- Mensageria (filas, DLQ e reprocessamento) ----------
  if (req.method === "GET" && url.pathname === "/api/mensageria/eventos") {
    const tipo = url.searchParams.get("tipo");
    const correlationId = (url.searchParams.get("correlationId") ?? "").trim();
    const limite = Math.min(500, Math.max(1, Number(url.searchParams.get("limite") ?? 50)));
    // Filtro por `correlationId`: é a trilha de correlação da tela Mensageria
    // (publicado → tentativa → falha → DLQ → ação do operador).
    const eventos = lerAuditoriaEventos()
      .filter((e: any) => (!tipo || e.tipo === tipo) && (!correlationId || e.correlationId === correlationId))
      .slice(-limite)
      .reverse();
    // Ações do operador sobre a DLQ (reprocessar/descartar): entram só
    // quando a trilha de uma correlação é pedida.
    const acoes = correlationId
      ? lerAuditoriaAcoes()
          .filter((e: any) => e.correlationId === correlationId)
          .slice(-limite)
          .reverse()
      : [];
    json(200, { eventos, acoes, assinantes: estadoAssinantes() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/mensageria/stats") {
    json(200, { filas: resumoFilas(), geradoEm: new Date().toISOString() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/mensageria/filas") {
    json(200, { filas: resumoFilas() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/mensageria/dlq") {
    const tipo = url.searchParams.get("tipo");
    json(200, { itens: itensDlq(tipo) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/mensageria/dlq/reprocessar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const id = String(b.id ?? "").trim();
      if (!id) {
        json(400, { erro: "informe o id do item" });
        return;
      }
      const r = await reprocessarItemDlq(id);
      json(r.ok ? 200 : 404, r.ok ? { ok: true, total: r.total } : { erro: r.erro ?? "item não encontrado na DLQ" });
    } catch (e: any) {
      json(400, { erro: String(e?.message ?? e) });
    }
    return;
  }
  // DESCARTAR — ação DESTRUTIVA: o item sai da DLQ e não volta para a fila.
  // Exige confirmação na UI e fica registrada na auditoria da Mensageria.
  if (req.method === "POST" && url.pathname === "/api/mensageria/dlq/descartar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const id = String(b.id ?? "").trim();
      if (!id) {
        json(400, { erro: "informe o id do item" });
        return;
      }
      const r = descartarItemDlq(id);
      json(r.ok ? 200 : 404, r.ok ? { ok: true, total: r.total } : { erro: r.erro ?? "item não encontrado na DLQ" });
    } catch (e: any) {
      json(400, { erro: String(e?.message ?? e) });
    }
    return;
  }
  // REPROCESSAR EM LOTE — reenfileira vários itens (por tipo ou por ids).
  // Só reenfileira: o envio continua no ritmo normal da fila (não vira rajada).
  if (req.method === "POST" && url.pathname === "/api/mensageria/dlq/reprocessar-lote") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const tipo = b.tipo === undefined || b.tipo === null ? "" : String(b.tipo).trim();
      const ids = Array.isArray(b.ids) ? b.ids.map((i: any) => String(i).trim()).filter(Boolean) : [];
      const r = await reprocessarLoteDlq({ tipo, ids });
      json(200, { ok: true, total: r.total, porTipo: r.porTipo ?? {}, itens: r.itens ?? [] });
    } catch (e: any) {
      json(400, { erro: String(e?.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/midia") {
    // Upload de imagem/vídeo para o disparo. JSON base64 (o painel lê o
    // arquivo local; multipart exigiria parser e não traz ganho aqui).
    try {
      const b = JSON.parse(await lerCorpo(req, 24 * 1024 * 1024));
      const nome = String(b.filename ?? "");
      const mime = String(b.mimetype ?? "").toLowerCase() || MIME_UPLOAD[extname(nome).toLowerCase()] || "";
      if (!MIME_ACEITO.has(mime)) {
        json(400, { erro: "formato não suportado (use JPG, PNG, WEBP, GIF ou MP4)" });
        return;
      }
      const b64 = String(b.base64 ?? "").replace(/^data:[^;]+;base64,/, "");
      if (!b64) {
        json(400, { erro: "arquivo não enviado" });
        return;
      }
      const bytes = Buffer.from(b64, "base64");
      if (!bytes.byteLength) {
        json(400, { erro: "arquivo vazio" });
        return;
      }
      if (bytes.byteLength > UPLOAD_MAX_BYTES) {
        json(413, { erro: "arquivo acima de 16 MB" });
        return;
      }
      const arquivo = salvarMidia(bytes.toString("base64"), mime);
      if (!arquivo) throw new Error("falha ao salvar a mídia");
      json(200, {
        ok: true,
        arquivo,
        mime,
        tipo: mime.startsWith("video") ? "video" : "image",
        nome: nome.slice(0, 120),
        bytes: bytes.byteLength,
      });
    } catch (e: any) {
      json(400, { erro: String(e?.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/disparos") {
    json(200, { disparos: listarDisparos(), resumo: resumoDisparos(), fila: estadoFilaClientes() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/disparos") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const listaId = String(b.listaId ?? "").trim();
      let jids: string[] = Array.isArray(b.jids) ? b.jids.map(String) : [];
      let listaNome: string | null = null;
      if (listaId) {
        const l = listarListas().find((x) => x.id === listaId);
        if (!l) throw new Error("lista não encontrada");
        jids = l.contatos;
        listaNome = l.nome;
      }
      // correlação do fluxo: campanha criada → mensagens enviadas → conclusão
      const correlationId = randomUUID();
      const d = comCorrelacao(correlationId, () =>
        criarDisparo({
          texto: String(b.texto ?? ""),
          link: String(b.link ?? ""),
          midia: b.midia === undefined ? null : midiaDoBody(b.midia),
          listaId: listaId || null,
          listaNome,
          jids,
          // número que envia a campanha (issue #45) — vazio/null = Automático
          instancia:
            b.instancia === undefined || b.instancia === null ? null : String(b.instancia ?? ""),
        }),
      );
      // EVENTO (Mensageria #51): o disparo foi criado. Quem assina é problema
      // do assinante — o painel não conhece auditoria, métricas nem log.
      try {
        publicarEvento("disparo.criado", { disparoId: d.id, total: d.total }, { correlationId });
      } catch {
        /* evento é acessório */
      }

      // Detecta se jids contém apenas um grupo (@g.us) - envia direto
      if (jids.length === 1 && jids[0].endsWith("@g.us")) {
        const grupoJid = jids[0];
        const texto = textoComLink(d.texto, d.link);
        const imagem = d.midia?.arquivo || String(b.imagem ?? "").trim();
        await enviarParaGrupo({
          grupo: grupoJid,
          imagem,
          legenda: texto,
          dryRun: false,
          // grupo direto também respeita o número fixado da campanha
          instancia: d.instancia ?? null,
        });
        registrarResultadoDisparo(d.id, true);
        json(200, { ok: true, disparo: d, enviado: true, grupo: grupoJid });
      } else {
        // Fluxo normal: enfileira individualmente
        try {
          // herda o correlationId da campanha (contexto de correlação)
          await comCorrelacao(correlationId, () =>
            enfileirarCampanha({
              texto: d.texto, link: d.link, midia: d.midia, jids: d.jids, disparoId: d.id,
              instancia: d.instancia ?? null,
            }),
          );
        } catch (e) {
          excluirDisparo(d.id); // rollback: não deixa disparo sem fila
          throw e;
        }
        json(200, { ok: true, disparo: d, fila: estadoFilaClientes() });
      }
    } catch (e: any) {
      json(400, { erro: String(e?.message ?? e) });
    }
    return;
  }
  const mDisparo = url.pathname.match(/^\/api\/disparos\/([^/]+)(\/duplicar)?$/);
  if (mDisparo) {
    const id = decodeURIComponent(mDisparo[1]);
    const acao = mDisparo[2];
    if (req.method === "PATCH" && !acao) {
      try {
        const b = JSON.parse(await lerCorpo(req));
        const patch: {
          texto?: string;
          link?: string | null;
          midia?: MidiaDisparo | null;
          instancia?: string | null;
        } = {};
        if (b.texto !== undefined) patch.texto = String(b.texto);
        if (b.link !== undefined) patch.link = String(b.link ?? "");
        if (b.midia !== undefined) patch.midia = midiaDoBody(b.midia);
        // troca do número que envia (issue #45) — vazio = volta para Automático
        if (b.instancia !== undefined) {
          patch.instancia = b.instancia === null ? null : String(b.instancia ?? "");
        }
        const d = editarDisparo(id, patch);
        const atualizados = await atualizarItensDaFila(id, {
          texto: d.texto,
          link: d.link,
          midia: d.midia,
          instancia: d.instancia,
        });
        json(200, { ok: true, disparo: d, filaAtualizada: atualizados });
      } catch (e: any) {
        json(400, { erro: String(e?.message ?? e) });
      }
      return;
    }
    if (req.method === "DELETE" && !acao) {
      const removidos = await removerItensDaFila(id);
      const ok = excluirDisparo(id);
      json(ok ? 200 : 404, ok ? { ok: true, removidos } : { erro: "disparo não encontrado" });
      return;
    }
    if (req.method === "POST" && acao === "/duplicar") {
      try {
        const d = duplicarDisparo(id);
        await enfileirarCampanha({
          texto: d.texto, link: d.link, midia: d.midia, jids: d.jids, disparoId: d.id,
        });
        json(200, { ok: true, disparo: d, fila: estadoFilaClientes() });
      } catch (e: any) {
        json(400, { erro: String(e?.message ?? e) });
      }
      return;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/monitor/grupos") {
    const s = carregarMonitor();
    json(200, { regras: s.regras, autoEnviar: s.autoEnviar, foto: s.foto });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/grupos") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      if (b.acao === "removerRegra") {
        removerRegra(b.origemJid ?? "");
      } else if (b.acao === "removerDestino") {
        removerDestino(b.origemJid ?? "", b.destinoJid ?? "");
      } else if (b.acao === "alternarOrigem") {
        alternarOrigem(b.origemJid ?? "");
      } else if (b.acao === "alternarDestino") {
        alternarDestino(b.origemJid ?? "", b.destinoJid ?? "");
      } else {
        // ação padrão: adicionar "um de cada vez" (origem + destino)
        adicionarRegra(b.origemJid ?? "", b.origemNome ?? "", b.destinoJid ?? "", b.destinoNome ?? "");
      }
      const s = carregarMonitor();
      json(200, { ok: true, regras: s.regras, autoEnviar: s.autoEnviar });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/auto") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirAutoEnviar(b.autoEnviar === true);
      json(200, { ok: true, autoEnviar: carregarMonitor().autoEnviar });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/foto") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      definirFoto(b.foto === "produto" ? "produto" : "origem");
      json(200, { ok: true, foto: carregarMonitor().foto });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/monitor/status") {
    const s = carregarMonitor();
    const destinos = s.regras.reduce((n, r) => n + r.destinos.length, 0);
    const { diasDedup, dedupPorOrigem } = await import("../monitor/state.js");
    json(200, {
      ...resumoMonitor(), autoEnviar: s.autoEnviar, origens: s.regras.length, destinos,
      fila: tamanhoFila(), intervaloFila: intervaloFila(),
      // adição de contatos em andamento (consome a taxa do WhatsApp)
      adicao: estadoAdicao(),
      // volume: por que as ofertas não foram para o grupo?
      volume: {
        dedupDias: diasDedup(),
        dedupPorOrigem: dedupPorOrigem(),
        taxaEncaminhada: resumoMonitor().recebidas
          ? Math.round((resumoMonitor().encaminhadas / resumoMonitor().recebidas) * 100)
          : 0,
      },
      eventos: eventosMonitor(50),
    });
    return;
  }
  // Reset: contadores (eventos) ou dedup — botões da UI
  if (req.method === "POST" && url.pathname === "/api/monitor/zerar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const alvo = String(b.alvo ?? "contadores");
      if (!["contadores", "dedup", "fila", "tudo"].includes(alvo)) {
        json(400, { erro: `alvo inválido: ${alvo} (use contadores|dedup|fila|tudo)` });
        return;
      }
      let removidos = 0;
      if (alvo === "dedup") removidos = limparDedup();
      else if (alvo === "fila") removidos = limparFila();
      else if (alvo === "tudo") {
        removidos = zerarContadores();
        limparDedup();
        limparFila();
      } else removidos = zerarContadores();
      json(200, { ok: true, alvo, removidos, ...resumoMonitor(), fila: tamanhoFila() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  // Conta pareada + estado (para trocar o celular)
  if (req.method === "GET" && url.pathname === "/api/monitor/sync-grupos") {
    json(200, { ok: true, ...estadoSyncGrupos(), autoOrigens: process.env.MONITOR_AUTO_ORIGENS !== "0" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/sync-grupos") {
    const r = await sincronizarGruposAgora("manual");
    json(200, { ...r, autoOrigens: process.env.MONITOR_AUTO_ORIGENS !== "0" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/monitor/conta") {
    const [estado, conta, instancia] = await Promise.all([
      estadoConexao(), contaPareada(), instanciaParaServico(),
    ]);
    // Remetente do Monitor: automático (rodízio entre os números liberados
    // para o fluxo "monitor" na aba Números) ou fixo (override do fluxo).
    // O painel mostra isso para o operador saber quem envia — antes só
    // aparecia a instância de serviço, que NÃO é a remetente.
    const itens = listarInstancias();
    const elegiveis = itens.filter(
      (i) => i.ativo && !i.pausado && i.permissoes?.monitor !== false
    );
    const fixada = overrideDoFluxo("monitor");
    json(200, {
      estado,
      ...conta,
      instancia,
      remetente: {
        modo: fixada ? "fixo" : "automatico",
        fixada,
        elegiveis: elegiveis.map((i) => ({ instancia: i.instancia, nome: i.nome, peso: i.peso })),
      },
    });
    return;
  }
  // Lista os grupos da conta pareada (origem/destino escolhidos daqui)
  if (req.method === "GET" && url.pathname === "/api/monitor/whats-grupos") {
    try {
      const forcar = url.searchParams.get("forcar") === "1";
      const grupos = await listarGrupos(forcar);
      json(200, { ok: true, total: grupos.length, grupos });
    } catch (e: any) {
      // Evolution limitada/fora do ar: serve a última lista salva em disco para
      // a aba Monitor não ficar sem grupos.
      const salvo = gruposDoCache();
      json(200, {
        ok: salvo.grupos.length > 0,
        erro: String(e?.message ?? e),
        aviso: salvo.grupos.length
          ? `Evolution indisponível (${String(e?.message ?? e)}) — mostrando a última lista salva${salvo.em ? " (" + new Date(salvo.em).toLocaleString("pt-BR") + ")" : ""}`
          : undefined,
        deCache: salvo.grupos.length > 0,
        total: salvo.grupos.length,
        grupos: salvo.grupos,
      });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/reiniciar") {
    try {
      await reiniciar();
      json(200, { ok: true, estado: await estadoConexao() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/desconectar") {
    // Troca de celular: desloga a conta atual e devolve um QR novo.
    try {
      await desconectar();
      const instancia = await instanciaParaServico();
      const r = await fetch(`${(process.env.EVO_URL ?? "").replace(/\/$/, "")}/instance/connect/${instancia}`, {
        headers: { apikey: process.env.EVO_KEY ?? "" },
      });
      const j: any = await r.json().catch(() => ({}));
      json(200, { ok: true, qr: j?.base64 ?? null, estado: await estadoConexao() });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/monitor/testar") {
    // Simula o pipeline com um texto (sem depender do webhook real).
    try {
      const b = JSON.parse(await lerCorpo(req));
      const oferta = detectarOferta(String(b.texto ?? ""));
      if (!oferta.principal) {
        // mesma expansão do webhook (curtos.ts): preview do painel refletir
        // links no domínio da própria origem (ex.: oferta.emipefps.com/...)
        const desconhecido = oferta.links.find((l) => l.programa === "desconhecido");
        if (desconhecido) {
          const exp = await expandirLink(desconhecido.url);
          if (exp) oferta.principal = exp;
        }
      }
      const msg = { origem: b.origem ?? "", deMim: false, texto: String(b.texto ?? ""), messageId: "teste" };
      const r = await processarMonitor(msg, { dryRun: true, conta: b.conta ?? undefined });
      json(200, {
        ok: true, resultado: r,
        principal: oferta.principal ? { programa: rotuloPrograma(oferta.principal.programa), id: oferta.principal.idProduto, url: oferta.principal.url } : null,
        mensagem: r.mensagem ?? null,
      });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/webhook/evolution") {
    // RF-030: entrada de mensagens do Evolution API (v2/GO).
    const wkey = process.env.WEBHOOK_KEY?.trim() || "";
    const headerW = req.headers["x-webhook-key"];
    if (!wkey || typeof headerW !== "string" || !iguais(headerW, wkey)) {
      json(401, { erro: "WEBHOOK_KEY inválida." });
      return;
    }
    try {
      const p = JSON.parse(await lerCorpo(req, 8 * 1024 * 1024));
      if (process.env.MONITOR_DEBUG === "1") {
        try {
          const d: any = (p as any)?.data ?? {};
          const m: any = d?.message ?? {};
          const img = m.imageMessage;
          const resumo = {
            ev: (p as any)?.event, jid: d?.key?.remoteJid, fromMe: d?.key?.fromMe,
            tipos: Object.keys(m),
            img: img ? {
              mimetype: img.mimetype, fileLength: img.fileLength,
              temUrl: !!img.url, temThumb: !!img.jpegThumbnail,
              caption: String(img.caption ?? "").slice(0, 500),
            } : null,
            texto: String(m.conversation ?? m.extendedTextMessage?.text ?? "").slice(0, 500),
            base64: m.base64 === undefined ? "ausente" : typeof m.base64 === "string" ? `string(${m.base64.length})` : typeof m.base64,
            mediaUrl: m.mediaUrl ? String(m.mediaUrl).slice(0, 60) : null,
          };
          const { appendFileSync } = await import("node:fs");
          appendFileSync(join(dataDir, "debug-webhook.log"), new Date().toISOString() + " " + JSON.stringify(resumo) + "\n", { mode: 0o600 });
        } catch { /* ignore */ }
      }
      const msg = extrairMensagem(p);
      if (!msg) return json(200, { ok: true, ignorado: "sem texto" });
      const r = await processarMonitor(msg, { dryRun: false });
      json(200, { ok: true, ...r });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  json(404, { erro: "rota?" });
}

function lerCorpo(req: any, max = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = "";
    let n = 0;
    let excedeu = false;
    req.setEncoding("utf8");
    req.on("data", (c: any) => {
      if (excedeu) return;
      n += c.length;
      if (n > max) {
        excedeu = true;
        return;
      }
      b += c;
    });
    req.on("end", () => {
      if (excedeu) reject(new Error("corpo grande"));
      else resolve(b);
    });
    req.on("error", reject);
  });
}

function origemPermitida(req: any): boolean {
  const site = req.headers?.["sec-fetch-site"];
  if (site === "cross-site") return false;
  const origin = req.headers?.origin;
  if (typeof origin !== "string" || !origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers?.host ?? "");
    return o.host === host && (o.protocol === "http:" || o.protocol === "https:");
  } catch {
    return false;
  }
}

const PAGINA = `<!DOCTYPE html><html lang="pt-BR" data-paleta="verde"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Alcance — central de ofertas que se espalham</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%23047857'/%3E%3Ccircle cx='12' cy='12' r='4' fill='none' stroke='%23fff' stroke-width='1.6'/%3E%3C/svg%3E">
<style>/* ============ PALETA ATIVA: VERDE — esmeralda + teal + lima ============ */
:root{
  color-scheme:light;
  --text:#15212a; --muted:#54636f; --faint:#7d8b96;
  --radius:10px; --radius-box:12px; --radius-card:16px;
  --shadow-sm:0 1px 2px rgba(15,23,42,.05),0 2px 8px rgba(15,23,42,.05);
  --shadow-md:0 10px 28px var(--shadow-tint);
  --code-tx:#243445;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --ok-soft:#e7f6ef; --ok-bd:#a9dcc6; --ok-tx:#0b5c43;
  --warn-soft:#fdf6e2; --warn-bd:#ecd28c; --warn-tx:#7a5410;
  --danger-soft:#fdecec; --danger-bd:#f2b8b8; --danger-tx:#8f1d1d;
  --info:#2563eb; --price:#047857;
  --border-strong:#c9d6d0;
  --primary:#047857; --primary-hover:#03624a; --primary-soft:#e0f3ea;
  --primary-border:#b0dcca; --primary-contrast:#ffffff; --ring:rgba(4,120,87,.26);
  --accent:#0f766e; --accent-soft:#d9f0ec;
  --tertiary:#65a30d; --tertiary-soft:#eef7d9;
  --grad-a:#0f766e; --grad-b:#047857;
  --bg:#e8f4ee; --bg-2:#d7ecdf;
  --surface:#fbfefc; --surface-2:#eff7f2;
  --card:#f2faf6; --card-2:#e3f1e9;
  --border:#d4e7dd;
  --code-bg:#eef6f1;
  --shadow-tint:rgba(4,120,87,.20);
}
/* ============ AREIA — taupe + bronze + areia ============ */
[data-paleta="areia"]{
  --primary:#8a6a4f; --primary-hover:#6f523c; --primary-soft:#f1e8dd;
  --primary-border:#dcc8b4; --primary-contrast:#ffffff; --ring:rgba(138,106,79,.24);
  --accent:#9c7c5b; --accent-soft:#f0e6da;
  --tertiary:#b08968; --tertiary-soft:#f4ebe1;
  --grad-a:#8a6a4f; --grad-b:#a9855f;
  --bg:#f4efe8; --bg-2:#ebe2d6;
  --surface:#fdfbf8; --surface-2:#f6f0e8;
  --card:#f9f2e9; --card-2:#efe3d4;
  --border:#e6dccf;
  --code-bg:#f6f0e8;
  --border-strong:#d8c9b8;
  --shadow-tint:rgba(138,106,79,.18);
  --info:#8a6a4f; --price:#7a5a3d;
}
/* ============ GRAFITE — carvão + pedra + fumo ============ */
[data-paleta="grafite"]{
  --primary:#44403c; --primary-hover:#292524; --primary-soft:#ece9e6;
  --primary-border:#cfc9c3; --primary-contrast:#ffffff; --ring:rgba(68,64,60,.22);
  --accent:#57534e; --accent-soft:#e9e6e3;
  --tertiary:#78716c; --tertiary-soft:#f0edeb;
  --grad-a:#44403c; --grad-b:#78716c;
  --bg:#f4f2f0; --bg-2:#e9e5e1;
  --surface:#fdfdfc; --surface-2:#f5f3f1;
  --card:#f8f5f2; --card-2:#ece7e2;
  --border:#e4dfda;
  --code-bg:#f4f2f0;
  --border-strong:#cfc8c1;
  --shadow-tint:rgba(41,37,36,.18);
  --info:#44403c; --price:#44403c;
}
/* ============ LARANJA — terracota + ambar + coral ============ */
[data-paleta="laranja"]{
  --primary:#c2410c; --primary-hover:#9a3412; --primary-soft:#fbe4d4;
  --primary-border:#f0bf9e; --primary-contrast:#ffffff; --ring:rgba(194,65,12,.24);
  --accent:#b45309; --accent-soft:#f8e9cf;
  --tertiary:#fb923c; --tertiary-soft:#fde6d2;
  --grad-a:#b45309; --grad-b:#c2410c;
  --bg:#fbf0e5; --bg-2:#f7e2cd;
  --surface:#fffdfa; --surface-2:#fdf4ea;
  --card:#fff8f0; --card-2:#fbe8d6;
  --border:#efdac3;
  --code-bg:#fdf4ea;
  --border-strong:#e5cbb0;
  --shadow-tint:rgba(194,65,12,.20);
}
/* ============ MARROM — café + caramelo + creme ============ */
[data-paleta="marrom"]{
  --primary:#7c4a2d; --primary-hover:#613720; --primary-soft:#f3e6db;
  --primary-border:#ddc3ae; --primary-contrast:#ffffff; --ring:rgba(124,74,45,.24);
  --accent:#8b5a3c; --accent-soft:#f2e2d6;
  --tertiary:#a97153; --tertiary-soft:#f6e8dd;
  --grad-a:#7c4a2d; --grad-b:#a97153;
  --bg:#f6ede5; --bg-2:#eddfd2;
  --surface:#fefbf8; --surface-2:#f8f0e9;
  --card:#fcf4ec; --card-2:#f2e4d6;
  --border:#e9d9cb;
  --code-bg:#f8f0e9;
  --border-strong:#dcc4b1;
  --shadow-tint:rgba(124,74,45,.20);
  --info:#7c4a2d; --price:#6b4226;
}
/* ============ CACAU — chocolate + moca + baunilha ============ */
[data-paleta="cacau"]{
  --primary:#4a2c1d; --primary-hover:#351e13; --primary-soft:#efe2d8;
  --primary-border:#d6bcaa; --primary-contrast:#ffffff; --ring:rgba(74,44,29,.24);
  --accent:#5d3a26; --accent-soft:#efe0d5;
  --tertiary:#8a5a3b; --tertiary-soft:#f3e5da;
  --grad-a:#4a2c1d; --grad-b:#7a4a30;
  --bg:#f1e7de; --bg-2:#e6d6c7;
  --surface:#fdfaf7; --surface-2:#f7efe7;
  --card:#faf2e9; --card-2:#f0e1d2;
  --border:#e3d2c2;
  --code-bg:#f7efe7;
  --border-strong:#d3bba8;
  --shadow-tint:rgba(74,44,29,.22);
  --info:#4a2c1d; --price:#5d3a26;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scrollbar-color:var(--border-strong) transparent}
body{
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:linear-gradient(168deg,var(--bg) 0%,var(--bg-2) 100%) fixed;
  color:var(--text);font-size:14px;line-height:1.5;
  padding:24px 18px 56px;max-width:1100px;margin:auto;
  transition:background .2s ease,color .2s ease;
}
h1{font-size:22px;font-weight:800;letter-spacing:-.01em;line-height:1.25;margin-bottom:6px}
h1 span{color:var(--primary)}
.sub{color:var(--muted);font-size:13.5px;margin-bottom:18px;max-width:75ch}
.sub b,.hint b{color:var(--text)}
a{color:var(--primary);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-radius:4px}
::selection{background:var(--primary);color:var(--primary-contrast)}
.brand{display:flex;align-items:center;gap:13px;margin:2px 0 10px}
.brand-mark{width:46px;height:46px;flex:0 0 auto;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--grad-a),var(--grad-b));box-shadow:0 8px 18px var(--shadow-tint)}
.brand-txt h1{font-size:27px;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin:0;background:linear-gradient(92deg,var(--grad-a),var(--grad-b));-webkit-background-clip:text;background-clip:text;color:transparent}
.tagline{font-size:12.5px;color:var(--muted);font-weight:600;margin-top:2px}
.tagline b{color:var(--text)}
/* ============ SELETOR DE TEMA (topbar) ============ */
.top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.tema{position:relative}
.tema summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;border:1px solid var(--border);background:var(--card);font-size:11.5px;font-weight:750;color:var(--text);box-shadow:var(--shadow-sm);transition:border-color .15s ease,box-shadow .15s ease}
.tema summary::-webkit-details-marker{display:none}
.tema summary::marker{content:""}
.tema summary:hover{border-color:var(--border-strong)}
.tema summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.tema[open] summary{border-color:var(--primary-border);box-shadow:0 0 0 3px var(--ring)}
.tema-dot{width:14px;height:14px;flex:0 0 auto;border-radius:50%;background:var(--primary);box-shadow:0 0 0 1px rgba(0,0,0,.08) inset}
.tema-caret{width:13px;height:13px;color:var(--muted);transition:transform .15s ease}
.tema[open] .tema-caret{transform:rotate(180deg)}
.tema-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:60;min-width:192px;padding:6px;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:0 18px 44px rgba(15,23,42,.20)}
.tema-opt{display:flex;align-items:center;gap:9px;width:100%;padding:8px 9px;border:none;border-radius:9px;background:transparent;color:var(--text);font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;text-align:left}
.tema-opt:hover{background:var(--card-2)}
.tema-opt[aria-pressed="true"]{background:var(--primary-soft);color:var(--primary-hover)}
.tema-opt[aria-pressed="true"]::after{content:"✓";margin-left:auto;font-weight:800}
.tema-sw{width:17px;height:17px;flex:0 0 auto;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.10) inset}
.tema-sw[data-sw="verde"]{background:linear-gradient(135deg,#0f766e,#047857 60%,#65a30d)}
.tema-sw[data-sw="laranja"]{background:linear-gradient(135deg,#b45309,#c2410c 60%,#fb923c)}
.tema-sw[data-sw="areia"]{background:linear-gradient(135deg,#b08968,#8a6a4f 60%,#d8c2ab)}
.tema-sw[data-sw="grafite"]{background:linear-gradient(135deg,#292524,#44403c 60%,#8a8178)}
.tema-sw[data-sw="marrom"]{background:linear-gradient(135deg,#613720,#7c4a2d 60%,#b98a68)}
.tema-sw[data-sw="cacau"]{background:linear-gradient(135deg,#351e13,#4a2c1d 60%,#8a5a3b)}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:18px;margin-bottom:16px;box-shadow:var(--shadow-sm)}
.panel{position:relative;overflow:hidden}
.panel::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--grad-a),var(--grad-b))}
.panel.ac-monitor::before{background:linear-gradient(90deg,var(--accent),var(--tertiary))}
.panel.ac-clientes::before{background:linear-gradient(90deg,var(--tertiary),var(--grad-b))}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:-2px 0 8px;font-size:13.5px;font-weight:600}
.panel>label:first-child{margin-top:0}
label{display:block;font-size:12px;font-weight:700;color:var(--muted);margin:10px 0 4px}
input,select,textarea{width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border-strong);border-radius:var(--radius);padding:10px;font-size:14px;font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease}
textarea{resize:vertical}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--ring)}
input:disabled,select:disabled,textarea:disabled{background:var(--surface-2);color:var(--faint);cursor:not-allowed}
input[type="checkbox"]{width:16px;height:16px;padding:0;accent-color:var(--primary);flex:0 0 auto}
button{font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;border:1px solid transparent;border-radius:var(--radius);padding:11px 14px;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .05s ease}
button:active{transform:translateY(1px)}
button:disabled{opacity:.55;cursor:not-allowed;transform:none}
button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.buscar,.enviar{background:linear-gradient(180deg,var(--grad-a),var(--grad-b));color:var(--primary-contrast);border-color:transparent;width:100%;margin-top:12px;font-size:15px;font-weight:800;box-shadow:0 6px 16px var(--shadow-tint)}
.buscar:hover,.enviar:hover{background:linear-gradient(180deg,var(--grad-b),var(--primary-hover));box-shadow:0 8px 20px var(--shadow-tint)}
.enviar{margin-top:10px}
.ghost{background:var(--surface);color:var(--text);border-color:var(--border-strong);width:100%;margin-top:12px;font-size:15px}
.ghost:hover{background:var(--surface-2);border-color:#bfc9d2}
.mbtn{background:var(--surface);color:var(--text);border-color:var(--border-strong);width:auto;margin:0;padding:7px 12px;font-size:12.5px;font-weight:600;border-radius:var(--radius);white-space:nowrap}
.mbtn:hover{background:var(--surface-2);border-color:#bfc9d2}
.mbtn.ok{background:linear-gradient(180deg,var(--grad-a),var(--grad-b));border-color:transparent;color:var(--primary-contrast)}
.mbtn.ok:hover{background:linear-gradient(180deg,var(--grad-b),var(--primary-hover))}
.tgl{background:var(--surface-2);color:var(--muted);border:1px solid var(--border-strong);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:800;letter-spacing:.02em}
.tgl:hover{color:var(--text);border-color:#bfc9d2}
.tgl.on{background:linear-gradient(180deg,var(--accent),var(--primary));border-color:transparent;color:var(--primary-contrast)}
.tgl.on:hover{filter:brightness(.95)}
.grid2{display:grid;grid-template-columns:2fr 1fr;gap:12px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:700px){
  body{padding:18px 14px 48px}
  .grid2{grid-template-columns:1fr}
  .grid4{grid-template-columns:1fr 1fr}
}
.badge{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.02em;border-radius:999px;padding:3px 10px;background:var(--surface-2);color:var(--muted);border:1px solid var(--border)}
.live{background:var(--ok-soft);color:var(--ok-tx);border-color:var(--ok-bd)}
/* issue #78: badge da origem "reenvio" (duplicata reagendada) */
.badge.reenvio{background:var(--primary-soft);color:var(--primary-hover);border-color:var(--primary-border)}
.mock{background:var(--warn-soft);color:var(--warn-tx);border-color:var(--warn-bd)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);overflow:hidden;box-shadow:var(--shadow-sm);transition:box-shadow .18s ease,transform .18s ease}
.card:hover{box-shadow:var(--shadow-md);transform:translateY(-2px);border-color:var(--primary-border)}
.card img{width:100%;height:170px;object-fit:cover;background:var(--card-2);display:block}
.noimg{height:110px;display:flex;align-items:center;justify-content:center;font-size:38px;color:var(--faint);background:linear-gradient(180deg,#f3f6f8,#e9eef2)}
.info{padding:14px;font-size:13px;line-height:1.5}
.info b.t{font-size:14px;display:block;margin-bottom:2px}
.preco{margin:8px 0}
.de{color:var(--muted);text-decoration:line-through}
.por{color:var(--price);font-weight:800;font-size:16px}
.meta{color:var(--muted);font-size:12px;margin:4px 0}
.link{color:var(--primary);font-weight:600;font-size:12px;word-break:break-all;overflow-wrap:anywhere}
.link:hover{text-decoration:underline}
.result{background:linear-gradient(160deg,var(--primary-soft),var(--accent-soft));border:1px solid var(--primary-border);border-radius:var(--radius-box);padding:14px;margin-top:14px;font-size:13px;display:none}
.result code{background:var(--code-bg);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--code-tx);font-family:var(--mono)}
code{font-family:var(--mono)}
.hint{font-size:12px;color:var(--muted);margin:6px 0 10px;line-height:1.55}
.hint b{color:var(--primary-hover)}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius-box);padding:12px;font-size:11.5px;font-family:var(--mono);line-height:1.55;color:var(--code-tx);white-space:pre-wrap;word-break:break-word;margin-top:10px;max-height:220px;overflow:auto;scrollbar-color:var(--border-strong) transparent}
.mrow{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:var(--card-2);border:1px solid var(--border);border-radius:var(--radius-box);padding:12px;margin-top:10px}
.mbox{background:var(--card-2);border:1px solid var(--border);border-radius:var(--radius-box);padding:14px;margin-top:10px}
.mini{font-size:12px;color:var(--muted);line-height:1.45}
.mini code{background:var(--code-bg);border:1px solid var(--border);padding:1px 6px;border-radius:6px;color:var(--code-tx);font-family:var(--mono);font-size:11px}
.regra{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--info);border-radius:var(--radius-box);padding:10px 12px;margin-top:8px}
.regra .orig{font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.regra .dest{font-size:13px;margin:8px 0 0 14px;padding:6px 0 0 10px;border-left:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.ctrls{display:flex;gap:6px;align-items:center;flex-shrink:0}
.regra.off{opacity:.55;background:var(--card-2)}
.regra.off .orig b{text-decoration:line-through}
.dest.off{opacity:.6}
.dest.off b{text-decoration:line-through}
.jidtag{color:var(--muted);font-size:11px;word-break:break-all;overflow-wrap:anywhere}
.malerta{border-radius:var(--radius-box);padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.55;border:1px solid}
.malerta.pare{background:var(--danger-soft);border-color:var(--danger-bd);color:var(--danger-tx)}
.malerta.warn{background:var(--warn-soft);border-color:var(--warn-bd);color:var(--warn-tx)}
.malerta.ok{background:var(--ok-soft);border-color:var(--ok-bd);color:var(--ok-tx)}
.lk-mini{color:var(--primary);font-size:12px;font-weight:600;text-decoration:none}
.lk-mini:hover{text-decoration:underline}
@media (prefers-reduced-motion:reduce){
  *{transition:none !important;animation:none !important}
  .card:hover{transform:none}
}
/* ============ APP SHELL — sidebar + views ============ */
body{padding:0;max-width:none;margin:0}
.app{display:flex;min-height:100vh;align-items:stretch}
.sidebar{width:258px;flex:0 0 258px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:14px;padding:18px 14px 14px;background:linear-gradient(180deg,var(--card) 0%,var(--card-2) 100%);border-right:1px solid var(--border);overflow-y:auto}
.side-brand{display:flex;align-items:center;gap:10px;padding:4px 6px 2px;border-radius:12px;text-decoration:none;color:var(--text)}
.side-brand:hover{text-decoration:none;background:var(--surface-2)}
.side-brand .brand-mark{width:40px;height:40px;border-radius:12px;font-size:21px;box-shadow:0 6px 14px var(--shadow-tint)}
.side-brand .brand-txt h1{font-size:20px;line-height:1.1;margin:0;background:linear-gradient(92deg,var(--grad-a),var(--grad-b));-webkit-background-clip:text;background-clip:text;color:transparent}
.side-brand .tagline{font-size:10.5px;margin-top:1px;font-weight:600}
.side-nav{display:flex;flex-direction:column;gap:5px}
.side-card{position:relative;display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid transparent;border-radius:14px;color:var(--text);text-decoration:none;transition:background .15s ease,border-color .15s ease,transform .15s ease}
.side-card:hover{background:var(--surface);border-color:var(--border);text-decoration:none;transform:translateX(2px)}
.side-card.active{background:linear-gradient(92deg,var(--primary-soft),var(--card));border-color:var(--primary-border);box-shadow:0 4px 14px var(--shadow-tint)}
.side-card:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.side-ico{width:36px;height:36px;flex:0 0 auto;border-radius:11px;display:flex;align-items:center;justify-content:center;color:var(--primary-hover);background:linear-gradient(135deg,var(--primary-soft),var(--card));border:1px solid var(--primary-border);transition:background .15s ease,border-color .15s ease,color .15s ease}
.side-ico svg{width:19px;height:19px;display:block}
.side-card:hover .side-ico{border-color:var(--primary)}
.side-card.active .side-ico{color:var(--primary-contrast);background:linear-gradient(135deg,var(--grad-a),var(--grad-b));border-color:transparent;box-shadow:0 5px 12px var(--shadow-tint)}
.side-txt{display:flex;flex-direction:column;min-width:0;line-height:1.2}
.side-txt b{font-size:13.5px;font-weight:750;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side-txt small{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side-badge{margin-left:auto;flex:0 0 auto;min-width:22px;text-align:center;font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:var(--muted)}
.side-card.active .side-badge{background:var(--primary);border-color:var(--primary);color:var(--primary-contrast)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:9px;padding-top:10px;border-top:1px solid var(--border)}
.side-live{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--muted);padding:0 4px;font-weight:600}
.live-dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.16)}
.live-dot.off{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}
.content{flex:1;min-width:0;max-width:1160px;margin:0 auto;padding:22px 28px 64px}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 18px;padding-bottom:14px;border-bottom:1px solid var(--border)}
.top-kicker{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.top-title{font-size:25px;font-weight:800;letter-spacing:-.025em;line-height:1.15;margin:3px 0 2px}
.top-sub{color:var(--muted);font-size:12.5px;max-width:72ch}
.top-live{font-size:11px;font-weight:700;padding:5px 11px;border-radius:999px;background:var(--ok-soft);border:1px solid var(--ok-bd);color:var(--ok-tx);white-space:nowrap}
.sair-btn{font-size:11px;font-weight:750;padding:5px 11px;border-radius:999px;background:var(--card);border:1px solid var(--border);color:var(--muted);cursor:pointer;transition:background .16s,border-color .16s,color .16s}
.sair-btn:hover{border-color:var(--danger-bd);background:var(--danger-soft);color:var(--danger-tx)}
.view{display:none}
.view.active{display:block;animation:viewIn .18s ease}
@keyframes viewIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:9px;margin:0 0 14px}
.kpi{position:relative;overflow:hidden;background:var(--card);border:1px solid var(--border);border-radius:13px;padding:10px 12px 9px;box-shadow:0 3px 10px rgba(0,0,0,.03)}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--grad-a),var(--grad-b));opacity:.75}
.kpi b{display:block;font-size:20px;font-weight:800;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums}
.kpi span{font-size:9.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.kpi.ok::before{background:linear-gradient(180deg,#16a34a,#65a30d)}
.kpi.warn::before{background:linear-gradient(180deg,#f59e0b,#f97316)}
.kpi.danger::before{background:linear-gradient(180deg,#dc2626,#be123c)}
@media (max-width:980px){
 .app{flex-direction:column}
 .sidebar{position:static;width:100%;height:auto;flex:none;flex-direction:row;align-items:center;gap:10px;padding:10px 12px;border-right:none;border-bottom:1px solid var(--border);overflow:visible}
 .side-brand{padding:0;flex:0 0 auto}
 .side-brand .tagline{display:none}
 .side-nav{flex-direction:row;flex:1 1 auto;min-width:0;overflow-x:auto;gap:4px;padding-bottom:2px}
 .side-card{padding:6px 8px;flex:0 0 auto}
 .side-txt small{display:none}
 .side-badge{display:none}
 .side-foot{margin:0;padding:0;border:none;flex:0 0 auto}
 .side-live{display:none}
 .content{padding:16px 14px 48px;max-width:none}
}
@media (max-width:700px){
 body{padding:0}
 .side-txt{display:none}
 .side-card{padding:6px}
 .side-brand .brand-txt{display:none}
 .side-ico{width:32px;height:32px;border-radius:10px}
 .side-ico svg{width:17px;height:17px}
 .side-brand .brand-mark{width:34px;height:34px;font-size:18px}
 .side-nav{gap:2px}
 .top-title{font-size:21px}
 .kpis{grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:7px}
 .kpi{padding:8px 9px 7px}
 .kpi b{font-size:17px}
}
/* ============================================================
   VIEW MENSAGERIA — tabelas, DLQ, trilha de correlação, modal
   e toasts (mesmo vocabulário visual do protótipo aprovado em
   docs/prototipos/mensageria/opcao-1.html)
   ============================================================ */
.tblwrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius-box);background:var(--surface)}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{background:var(--card-2);color:var(--muted);font-size:9.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;text-align:left;padding:9px 11px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:9px 11px;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl tbody tr:last-child td{border-bottom:none}
.tbl tbody tr:hover{background:var(--card)}
.tbl tbody tr.sel{background:var(--primary-soft)}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
.tbl .mono{font-family:var(--mono);font-size:11px;color:var(--code-tx);background:var(--code-bg);border:1px solid var(--border);padding:1px 6px;border-radius:6px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.tbl .nowrap{white-space:nowrap}
.copybtn{background:none;border:none;padding:1px 4px;font-size:11px;color:var(--muted);cursor:pointer;border-radius:6px;line-height:1}
.copybtn:hover{background:var(--card-2);color:var(--primary)}
.trunc{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}
/* DLQ — colunas justas para caber sem rolagem lateral em 1440px */
.tbl-dlq{table-layout:fixed;min-width:0}
.tbl-dlq th,.tbl-dlq td{padding:8px 9px}
.tbl-dlq th:nth-child(1),.tbl-dlq td:nth-child(1){width:132px}
.tbl-dlq th:nth-child(2),.tbl-dlq td:nth-child(2){width:156px}
.tbl-dlq th:nth-child(3),.tbl-dlq td:nth-child(3){width:108px}
.tbl-dlq th:nth-child(4),.tbl-dlq td:nth-child(4){width:42px}
.tbl-dlq th:nth-child(5),.tbl-dlq td:nth-child(5){width:92px}
.tbl-dlq th:nth-child(6),.tbl-dlq td:nth-child(6){width:100px}
.tbl-dlq th:nth-child(7),.tbl-dlq td:nth-child(7){width:140px}
.tbl-dlq th:nth-child(8),.tbl-dlq td:nth-child(8){width:252px}
.tbl-dlq td:nth-child(8){white-space:normal}
.tbl-dlq td:nth-child(8) .mbtn{margin:2px 3px 2px 0;padding:4px 7px;font-size:11px}
.dlq-chave{display:flex;align-items:center;gap:5px;min-width:0}
.dlq-chave .mono.trunc{flex:1 1 auto;min-width:0}
.dlq-chave .copybtn{flex:0 0 auto}
.tbl-dlq .trunc{max-width:100%}
.tbl-dlq .mono.trunc{width:100%}

.skel{background:linear-gradient(90deg,var(--card-2) 25%,var(--surface-2) 50%,var(--card-2) 75%);background-size:200% 100%;animation:sk 1.2s infinite;border-radius:6px;height:12px}
.skel.lg{height:22px}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--border-strong);border-top-color:var(--primary);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:5px}
@keyframes sp{to{transform:rotate(360deg)}}
.mbtn.danger{color:var(--danger-tx);border-color:var(--danger-bd);background:var(--danger-soft)}
.mbtn.danger:hover{background:#fbdada}
.mbtn.sm{padding:4px 9px;font-size:11.5px;border-radius:8px}
.mbtn.ghosty{background:var(--surface)}
.alerta{border-radius:var(--radius-box);padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.55;border:1px solid;background:var(--surface);border-color:var(--border);color:var(--text)}
.alerta.pare{background:var(--danger-soft);border-color:var(--danger-bd);color:var(--danger-tx)}
.alerta.warn{background:var(--warn-soft);border-color:var(--warn-bd);color:var(--warn-tx)}
.alerta.ok{background:var(--ok-soft);border-color:var(--ok-bd);color:var(--ok-tx)}
.alerta b{font-weight:750}
.empty{padding:36px 16px;text-align:center;color:var(--muted)}
.empty .ico{font-size:26px;display:block;margin-bottom:6px}
.empty b{display:block;color:var(--text);font-size:13.5px;margin-bottom:3px}
.tabs{display:flex;gap:5px;flex-wrap:wrap;margin:-2px 0 10px}
.tab{background:var(--surface);border:1px solid var(--border-strong);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:650;color:var(--muted);cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}
.tab:hover{background:var(--surface-2);color:var(--text)}
.tab.on{background:linear-gradient(180deg,var(--grad-a),var(--grad-b));border-color:transparent;color:var(--primary-contrast)}
.tab .cnt{opacity:.7;font-weight:700}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.tools select,.tools input{width:auto;min-width:150px;padding:6px 9px;font-size:12px}
.tools input{min-width:230px}
.evt{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px}
.evt:last-child{border-bottom:none}
.evt time{font-family:var(--mono);font-size:10.5px;color:var(--faint);flex:0 0 auto}
.evt .t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.evt .c{flex:0 0 auto}
.mods{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.44)}
.mods.on{display:flex}
.mod{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);box-shadow:0 24px 60px rgba(15,23,42,.30);width:100%;max-width:470px;overflow:hidden}
.mod::before{content:"";display:block;height:3px;background:linear-gradient(90deg,var(--grad-a),var(--grad-b))}
.mod.danger::before{background:linear-gradient(90deg,#dc2626,#be123c)}
.mod-h{padding:16px 18px 2px}
.mod-h b{font-size:15px;font-weight:800}
.mod-b{padding:6px 18px 4px;font-size:13px;color:var(--muted);line-height:1.55}
.mod-f{padding:12px 18px 16px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(470px,100%);z-index:82;background:var(--card);border-left:1px solid var(--border);box-shadow:-18px 0 50px rgba(15,23,42,.20);transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column}
.drawer.on{transform:none}
.drawer-h{padding:15px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.drawer-b{padding:16px 18px;overflow:auto;flex:1}
.drawer-f{padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end}
.trail{list-style:none;margin:0;padding:0}
.trail li{position:relative;padding:0 0 16px 22px;border-left:2px solid var(--border);margin-left:6px}
.trail li:last-child{border-left-color:transparent;padding-bottom:0}
.trail li::before{content:"";position:absolute;left:-7px;top:3px;width:12px;height:12px;border-radius:50%;background:var(--surface);border:2px solid var(--primary)}
.trail li.bad::before{border-color:#dc2626}
.trail li.warn::before{border-color:#f59e0b}
.trail li.mute::before{border-color:var(--border-strong)}
.trail b{font-size:12.5px}
.trail .st{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.toasts{position:fixed;right:18px;bottom:18px;z-index:90;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 36px))}
.toast{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:12px;box-shadow:var(--shadow-md);padding:10px 13px;font-size:12.5px;display:flex;gap:9px;align-items:flex-start;animation:tin .18s ease}
.toast.err{border-left-color:#dc2626}
.toast.warn{border-left-color:#f59e0b}
@keyframes tin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:12px;margin:8px 0 0}
.kv dt{color:var(--muted);font-weight:650;white-space:nowrap}
.kv dd{margin:0;word-break:break-all}
@media(max-width:700px){
  .tools select,.tools input{min-width:0;width:100%}
 .tbl{font-size:12px}
}
.grid2b{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:980px){.grid2b{grid-template-columns:1fr}}
</style></head>
<body>
<script>try{var p=localStorage.getItem('paleta');var ok={verde:1,laranja:1,areia:1,grafite:1,marrom:1,cacau:1};if(p&&ok[p]){document.documentElement.setAttribute('data-paleta',p);}}catch(e){}</script>
<div class="app">
<aside class="sidebar">
<a class="side-brand" href="#/monitor" aria-label="Alcance — ir para o monitor">
<div class="brand-mark">A</div>
<div class="brand-txt"><h1>Alcance</h1><div class="tagline">capta · filtra · distribui</div></div>
</a>
<nav class="side-nav" aria-label="Navegação principal">
<a class="side-card" data-view="contas" href="#/contas">
<span class="side-ico i-contas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="8.7" cy="10.2" r="1.9"/><path d="M5.8 16.2c.5-1.7 1.6-2.6 2.9-2.6s2.4.9 2.9 2.6M14 8.8h4.2M14 12.2h3.2M14 15.6h2.2"/></svg></span>
<span class="side-txt"><b>Contas</b><small>etiquetas & vínculos</small></span>
<span class="side-badge" id="badge-contas">—</span>
</a>
<a class="side-card" data-view="cupons" href="#/cupons">
<span class="side-ico i-cupons"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h12a2.5 2.5 0 0 1 2.5 2.5v1.2a2.3 2.3 0 0 0 0 4.6v1.2A2.5 2.5 0 0 1 18 18H6a2.5 2.5 0 0 1-2.5-2.5v-1.2a2.3 2.3 0 0 0 0-4.6z"/><path d="M13.2 9.2l-2.4 5.6"/><path d="M10.7 10.7h.01M13.2 13.3h.01" stroke-width="2.4"/></svg></span>
<span class="side-txt"><b>Cupons</b><small>códigos & ML</small></span>
<span class="side-badge" id="badge-cupons">—</span>
</a>
<a class="side-card" data-view="piloto" href="#/piloto">
<span class="side-ico i-piloto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 3.2c2.6 1.8 4.1 4.9 4.1 8.2l-4.1 4.1-4.1-4.1c0-3.3 1.5-6.4 4.1-8.2z"/><circle cx="12.2" cy="9" r="1.6"/><path d="M8.1 13.4l-2.3 1.5.6 3 2.9-.9M16.3 13.4l2.3 1.5-.6 3-2.9-.9"/><path d="M10.4 18.7c.5 1.3 1.2 2.1 1.8 2.3.6-.2 1.3-1 1.8-2.3"/></svg></span>
<span class="side-txt"><b>Piloto</b><small>ofertas automáticas</small></span>
<span class="side-badge" id="badge-piloto">—</span>
</a>
<a class="side-card" data-view="monitor" href="#/monitor">
<span class="side-ico i-monitor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.8" opacity=".35"/><circle cx="12" cy="12" r="5.2" opacity=".6"/><circle cx="12" cy="12" r="1.4"/><path d="M12 12l6.2-6.2"/><path d="M12 12l4.4 2.6" opacity=".5"/></svg></span>
<span class="side-txt"><b>Monitor</b><small>encaminhamento</small></span>
<span class="side-badge" id="badge-monitor">—</span>
</a>
<a class="side-card" data-view="numeros" href="#/numeros">
<span class="side-ico i-numeros"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.8" y="3" width="10.4" height="18" rx="2.6"/><path d="M10.8 17.8h2.8"/><path d="M18.6 8.4c1.3.9 1.3 6.3 0 7.2" opacity=".55"/><path d="M20.6 6.2c2 1.6 2 10 0 11.6" opacity=".3"/></svg></span>
<span class="side-txt"><b>Números</b><small>envio rotativo</small></span>
<span class="side-badge" id="badge-numeros">—</span>
</a>
<a class="side-card" data-view="rastreio" href="#/rastreio">
<span class="side-ico i-clientes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/></svg></span>
<span class="side-txt"><b>Rastreio</b><small>o que foi publicado</small></span>
<span class="side-badge" id="badge-rastreio">—</span>
</a>
<a class="side-card" data-view="clientes" href="#/clientes">
<span class="side-ico i-clientes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.2" r="3"/><path d="M3.4 19.2c.7-3 2.8-4.9 5.6-4.9s4.9 1.9 5.6 4.9"/><circle cx="17.2" cy="9.3" r="2.3"/><path d="M15.9 14.5c2.2.4 3.8 2.1 4.4 4.7"/></svg></span>
<span class="side-txt"><b>Clientes</b><small>disparo individual</small></span>
<span class="side-badge" id="badge-clientes">—</span>
</a>
<a class="side-card" data-view="mensageria" href="#/mensageria">
<span class="side-ico i-mensageria"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 12.8h4.1l1.7 2.7h5.2l1.7-2.7h4.1"/><path d="M6.1 4.9h11.8l2.5 7.9v4.4a2.2 2.2 0 0 1-2.2 2.2H5.8a2.2 2.2 0 0 1-2.2-2.2v-4.4z"/><path d="M9.4 8.6h5.2"/></svg></span>
<span class="side-txt"><b>Mensageria</b><small>filas &amp; DLQ</small></span>
<span class="side-badge" id="badge-mensageria">—</span>
</a>
</nav>
<div class="side-foot">
<div class="side-live"><span class="live-dot" id="side-dot"></span><span id="side-live-txt">monitor · —</span></div>
</div>
</aside>
<main class="content">
<header class="topbar">
<div><div class="top-kicker" id="top-kicker">operação</div><h2 class="top-title" id="top-title">Monitor</h2><div class="top-sub" id="top-sub">Cada grupo de origem encaminha para os seus destinos, com troca de link e anti-rajada.</div></div>
<div class="top-actions">
<details class="tema" id="temaBox">
<summary class="tema-btn" title="Mudar as cores do sistema"><span class="tema-dot" id="temaDot"></span><span id="temaNome">Verde</span><svg class="tema-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></summary>
<div class="tema-menu" role="group" aria-label="Tema de cores">
<button type="button" class="tema-opt" data-p="verde" aria-pressed="true"><span class="tema-sw" data-sw="verde"></span>Verde</button>
<button type="button" class="tema-opt" data-p="laranja" aria-pressed="false"><span class="tema-sw" data-sw="laranja"></span>Laranja</button>
<button type="button" class="tema-opt" data-p="areia" aria-pressed="false"><span class="tema-sw" data-sw="areia"></span>Areia</button>
<button type="button" class="tema-opt" data-p="grafite" aria-pressed="false"><span class="tema-sw" data-sw="grafite"></span>Grafite</button>
<button type="button" class="tema-opt" data-p="marrom" aria-pressed="false"><span class="tema-sw" data-sw="marrom"></span>Marrom</button>
<button type="button" class="tema-opt" data-p="cacau" aria-pressed="false"><span class="tema-sw" data-sw="cacau"></span>Cacau</button>
</div>
</details>
<span class="top-live" id="top-live">● monitor · —</span>
<button type="button" class="sair-btn" id="sair" title="Encerrar sessão">Sair</button>
</div>
</header>
<section class="view" id="view-contas" data-view="contas">
<div class="kpis">
<div class="kpi"><b id="kpi-contas">—</b><span>contas</span></div>
<div class="kpi"><b id="kpi-cuponsn">—</b><span>cupons</span></div>
</div>
<div class="panel ac-contas">
<label>👥 Contas de afiliado (uma etiqueta por categoria, se quiser)</label>
<div class="hint">Sem conta extra, tudo usa a <b>padrão</b> (sua etiqueta vale para todas as categorias). Cookies nunca voltam pela API.</div>
<div id="contasout" style="margin:8px 0;font-size:13px"></div>
<div class="grid4">
<div><label>Nome (ex.: eletronicos)</label><input id="cnome" placeholder="apelido"></div>
<div><label>Etiqueta (tag)</label><input id="ctag" placeholder="rm…"></div>
<div><label>Cookie (sessão)</label><input id="ccookie" type="password" placeholder="cole o Cookie"></div>
<div><label>&nbsp;</label><button class="buscar" style="margin-top:0" onclick="salvarContaUI()">💾 Salvar conta</button></div></div>
<div class="grid2"><div><label>Categoria → conta + grupo + sub</label><select id="mapcat"></select></div>
<div><label>&nbsp;</label><div style="display:flex;gap:8px"><select id="mapconta" style="flex:1"><option value="-">Padrão</option></select><select id="mapgrupo" style="flex:2"><option value="">Grupo padrão (.env)</option></select></div></div></div>
<div style="display:flex;gap:8px;margin-top:8px"><select id="mapsub" style="flex:1"><option value="">Sem filtro (categoria inteira)</option></select><button class="buscar" style="margin-top:0;width:auto" onclick="salvarMapa()">✔ Salvar vínculo</button></div>
<div class="hint">Ex.: Joias e Relógios → conta <b>principal</b> + grupo <b>Radar Teste</b>. Cada categoria pode ter sua etiqueta e seu grupo.</div>
</div>
</section>
<section class="view" id="view-cupons" data-view="cupons">
<div class="kpis">
<div class="kpi"><b id="kpi-cupons-reg">—</b><span>registrados</span></div>
<div class="kpi ok"><b id="kpi-cupons-ml">—</b><span>cupons ML na categoria</span></div>
</div>
<div class="panel ac-cupons">
<div style="margin-top:10px"><label>🎟️ Cupons (códigos digitáveis, estilo Emipe — criados no portal)</label>
<div class="hint">Cadastre 1 vez (ex.: chave <b>MLB1000</b>, código <b>PRIMEHOJE</b>) → anexado sozinho nas mensagens. Cupons do ML (clique-aplicar) vêm sozinhos por categoria.</div>
<div id="cuponsout" style="font-size:13px"></div>
<div style="display:flex;gap:8px;margin-top:6px"><input id="cpchave" style="flex:1" placeholder="chave: MLB1000 ou MLB1000:principal"><input id="cpcode" style="flex:1" placeholder="código: PRIMEHOJE"><input id="cpnome" style="flex:1" placeholder="nome: 10% OFF Voltagem"><button class="buscar" style="margin-top:0;width:auto" onclick="salvarCupomUI()">💾</button></div>
<div id="cuponsml" style="font-size:12px;margin-top:6px;color:var(--mut)"></div></div>
</div>
</section>
<section class="view" id="view-piloto" data-view="piloto">
<div class="sub">Escolha <b>etiqueta → categoria → grupo</b>, aperte <b>LIGA TUDO</b> e receba <b>2 ofertas a cada 5 min</b> por categoria no WhatsApp (com pausa de 8 min a cada 55 min).</div>
<div class="kpis">
<div class="kpi"><b id="kpi-loops">—</b><span>loops ativos</span></div>
<div class="kpi ok"><b id="kpi-piloto-env">—</b><span>enviadas</span></div>
<div class="kpi"><b id="kpi-piloto-ult">—</b><span>último envio</span></div>
</div>
<div class="panel ac-piloto">
<div class="panel-head"><span><b id="tit-piloto">🚀 Piloto automático</b> — 2 ofertas aleatórias a cada 5 min, sozinho</span><a class="lk-mini" href="#" onclick="renomearCard('piloto');return false">✏️ renomear</a></div>
<div class="hint">Aperte <b>LIGA TUDO</b> e esqueça: liga 1 loop por categoria amarrada (conta+grupo do mapa, até 20). Ou monte 1 loop manual abaixo.</div>
<div style="display:flex;gap:8px;margin-bottom:10px"><button class="buscar" style="margin-top:0;flex:1;font-size:16px" onclick="ligaTudo()">▶ LIGA TUDO (automático)</button><button class="ghost" style="margin-top:0;flex:1" onclick="pilotoStop()">⏹ DESLIGA TUDO</button></div>
<div class="grid4">
<div><label>Programa</label><select id="paprograma" onchange="trocarProgramaPiloto()">
  <option value="ml">Mercado Livre</option>
  <option value="amazon">Amazon</option></select></div>
<div><label>Etiqueta rastreada</label><select id="paconta"></select></div>
<div><label>Categoria</label><select id="pacat"></select></div>
<div><label>Grupo de destino</label><select id="pagrupo"></select></div></div>
<div class="grid4" style="margin-top:8px">
<div id="pmlsubbox"><label>Subcategoria (filtro)</label><select id="pasub"><option value="">Categoria inteira</option></select></div>
<div id="pamazoninfo" style="grid-column:span 3;align-self:end;font-size:13px" class="mini"></div></div>
<div class="grid4" style="margin-top:8px">
<div><label>Postagens por ciclo</label><select id="paqtd"><option value="2">2 por ciclo</option><option value="1">1 por ciclo</option></select></div>
<div><label>Intervalo entre elas</label><select id="pagap"><option value="45">45s</option><option value="60" selected>1 min</option><option value="90">1:30 min</option></select></div>
<div><label>Filtro por palavra (opcional)</label><input id="pafiltro" placeholder="ex.: perfume" maxlength="60" style="width:100%;"></div>
</div>
<div style="display:flex;gap:8px;margin-top:8px"><button class="buscar" style="margin-top:0;flex:1" onclick="pilotoStart()">▶ START</button><button class="ghost" style="margin-top:0;flex:1" onclick="pilotoStop()">⏹ STOP TUDO</button></div>
<div id="pstatus" style="margin-top:8px;font-size:13px"></div>
<pre id="plog" style="max-height:140px"></pre>
<div class="grid2" style="margin-top:8px"><div><label>Cesta da categoria (cole 1 vez — rodízio automático com foto)</label><textarea id="cestatext" rows="3" style="width:100%;" placeholder="URL | pix | de | título | foto (um por linha)"></textarea></div>
<div><label>&nbsp;</label><div id="cestainfo" style="font-size:12px;margin-bottom:8px"></div><div style="display:flex;gap:8px"><button class="buscar" style="margin-top:0" onclick="salvarCestaUI()">💾 Guardar links</button><button class="ghost" style="margin-top:0" onclick="limparCestaUI()">🗑 Limpar</button></div></div></div>
<div style="margin-top:10px"><label>🏬 Vitrine ML (ofertas reais com preço+foto — sem colar nada)</label>
<div class="hint">Folhas descobertas no perfil de afiliado. Amarre cada folha a uma categoria 1 vez → o piloto usa sozinho.</div>
<div id="vitrineout" style="font-size:13px">carregando vitrine…</div></div>
</div>
</section>
<section class="view" id="view-monitor" data-view="monitor">
<div class="kpis">
<div class="kpi"><b id="kpi-recebidas">—</b><span>recebidas</span></div>
<div class="kpi ok"><b id="kpi-encaminhadas">—</b><span>encaminhadas</span></div>
<div class="kpi"><b id="kpi-origens">—</b><span>origens</span></div>
<div class="kpi"><b id="kpi-destinos">—</b><span>destinos</span></div>
<div class="kpi"><b id="kpi-duplicadas">—</b><span>duplicadas</span></div>
<div class="kpi warn"><b id="kpi-revisao">—</b><span>revisão</span></div>
<div class="kpi danger"><b id="kpi-erros">—</b><span>erros</span></div>
<div class="kpi"><b id="kpi-fila">—</b><span>na fila</span></div>
</div>
<div class="mbox" id="mvolume" style="margin:0 0 10px"></div>
<div class="panel ac-monitor">
<div class="panel-head"><span><b id="tit-monitor">📡 Monitor</b> — cada grupo de origem encaminha para os SEUS destinos</span><a class="lk-mini" href="#" onclick="renomearCard('monitor');return false">✏️ renomear</a></div>
<div class="hint">Oferta publicada numa <b>origem</b> (grupo de achadinhos que você monitora) tem o link trocado pelo <b>seu</b> e é reenviada <b>apenas</b> para os destinos amarrados àquela origem. Uma origem pode ter vários destinos.</div>

<div class="mrow">
<div><b id="mcontalabel">Conta WhatsApp: …</b><br><span class="mini" id="mcontaestado"></span></div>
<div style="display:flex;gap:8px"><button class="mbtn" onclick="reiniciarEvo()">↻ Reconectar</button><button class="mbtn" onclick="irParaNumeros()" title="gerenciar os números que enviam (aba Números)">📱 Números</button><button class="mbtn" onclick="trocarCelular()" title="desloga a conta atual para parear outro celular">Deslogar e parear outro</button></div></div>

<div class="mrow">
<div><b id="mautolabel">Envio direto — OFF (vai p/ revisão)</b><br><span class="mini">ON encaminha sozinho • OFF apenas registra para revisão</span></div>
<button class="mbtn" id="mautobtn" onclick="toggleAutoMonitor()">Ligar envio direto</button></div>
<div id="malerta"></div>

<div class="mrow">
<div><b id="mfotolabel">Foto do repasse: …</b><br><span class="mini">"Da origem" usa a MESMA foto que o post monitorado publicou; se o post for só texto, cai para a foto do anúncio.</span></div>
<div style="display:flex;gap:6px">
<button class="mbtn" id="mfotoorigem" onclick="definirFotoUI('origem')">Da origem</button>
<button class="mbtn" id="mfotoproduto" onclick="definirFotoUI('produto')">Do anúncio</button></div></div>

<div class="mbox">
<label>➕ Nova regra — escolha <b>uma</b> origem e <b>um</b> destino</label>
<div class="grid2">
<div><label>Origem (grupo que eu monitoro)</label><select id="mselOrigem"><option value="">— carregue os grupos —</option></select></div>
<div><label>Destino (meu grupo que recebe)</label><select id="mselDestino"><option value="">— carregue os grupos —</option></select></div></div>
<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
<button class="mbtn ok" onclick="adicionarRegraUI()">➕ Adicionar regra</button>
<button class="mbtn" onclick="carregarGruposSelects(1)">🔄 Carregar grupos da conta</button>
<span class="mini" id="mgruposinfo" style="align-self:center"></span></div>
<div class="mini" style="margin-top:6px">Dica: para dar <b>mais de um destino</b> à mesma origem, escolha a mesma origem de novo com outro destino.</div></div>

<div class="mbox">
<label>🔒 Permissões do grupo — <span class="mini">quem pode falar/comentar</span></label>
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
<select id="mselPermissao" style="flex:1;min-width:170px"><option value="">— carregue os grupos —</option></select>
<button class="mbtn ok" onclick="permissaoGrupoUI('announcement')">🔒 Só admins falam</button>
<button class="mbtn" onclick="permissaoGrupoUI('not_announcement')">🔓 Todos falam</button>
<button class="mbtn" onclick="permissaoGrupoUI('locked')">🛡 Só admins editam</button>
<button class="mbtn" onclick="permissaoGrupoUI('unlocked')">🔓 Todos editam</button>
<span class="mini" id="mpermissaoinfo" style="align-self:center"></span></div>
<div class="mini" style="margin-top:6px">"Só admins falam" bloqueia mensagens e comentários dos participantes (modo anúncio do WhatsApp). A conta pareada precisa ser <b>admin</b> do grupo.</div></div>

<div style="margin-top:12px"><label>🔗 Regras ativas <span class="mini" id="mregrasn"></span></label>
<div id="mregras"></div></div>

<div id="mstatus" style="margin-top:10px;font-size:13px"></div>
<div id="mfila" style="margin-top:6px;font-size:13px"></div>
<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
<button class="mbtn" onclick="zerarContadoresUI()">🧹 Zerar contadores</button>
<button class="mbtn" onclick="limparDedupUI()">♻️ Limpar dedup</button>
<button class="mbtn" onclick="limparFilaUI()">🗑 Esvaziar fila</button>
<span class="mini" id="mresetout" style="align-self:center"></span></div>
<div class="grid2" style="margin-top:8px">
<div><label>Testar reconhecimento (cole a mensagem recebida)</label><textarea id="mteste" rows="3" style="width:100%;" placeholder="Cole aqui uma mensagem com link de afiliado..."></textarea>
<div style="display:flex;gap:8px;margin-top:6px"><select id="mtesteorigem" style="flex:1"><option value="">primeira origem das regras</option></select><button class="mbtn ok" onclick="testarMonitor()">🧪 Testar</button></div>
<pre id="mtesteout"></pre></div>
<div><label>Últimos eventos do monitor</label><pre id="meventos" style="max-height:220px"></pre></div></div>
</div>
</section>
<section class="view" id="view-numeros" data-view="numeros">
<div class="kpis">
<div class="kpi"><b id="kpi-numerosn">—</b><span>números</span></div>
<div class="kpi ok"><b id="kpi-numeros-on">—</b><span>conectados</span></div>
</div>
<div class="panel ac-numeros">
<div class="panel-head"><span><b id="tit-numeros">📱 Números</b> para envio rotativo <span class="mini" id="minstmax"></span></span><a class="lk-mini" href="#" onclick="renomearCard('numeros');return false">✏️ renomear</a></div>
<div class="mini" style="margin-bottom:6px"><b>★ Principal</b> = número de casa, preferido para as <b>operações de serviço</b> (adicionar contatos ao grupo, permissões). <b>Todos os números abertos</b> — principal inclusive — participam do <b>envio de mensagens</b>, na proporção do peso. Se um cair, o envio continua pelos outros. A conta ML continua a mesma.</div>
<div class="mini" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
<span><b>Remetente por fluxo</b> (padrão: automático)</span>
<label>Piloto <select id="ov-piloto" onchange="definirOverrideUI('piloto',this.value)"><option value="">Automático</option></select></label>
<button class="mbtn" onclick="definirOverrideUI('piloto','')" title="voltar ao automático">↺</button>
<label>Monitor <select id="ov-monitor" onchange="definirOverrideUI('monitor',this.value)"><option value="">Automático</option></select></label>
<button class="mbtn" onclick="definirOverrideUI('monitor','')" title="voltar ao automático">↺</button>
<label>Disparo <select id="ov-disparo" onchange="definirOverrideUI('disparo',this.value)"><option value="">Automático</option></select></label>
<button class="mbtn" onclick="definirOverrideUI('disparo','')" title="voltar ao automático">↺</button>
</div>
<div id="minstlist" class="mini">carregando…</div>
<div style="display:flex;gap:6px;margin-top:8px">
<input id="minstnome" placeholder="nome do celular (ex.: Celular 2)" maxlength="24" style="flex:1;">
<button class="mbtn" onclick="addInstancia()">➕ Adicionar celular</button></div>
<div id="minstqr" style="margin-top:10px"></div>
</div>
</section>
<section class="view" id="view-rastreio" data-view="rastreio">
<div class="kpis">
<div class="kpi"><b id="kpi-rt-total">—</b><span>publicações</span></div>
<div class="kpi"><b id="kpi-rt-ml">—</b><span>Mercado Livre</span></div>
<div class="kpi ok"><b id="kpi-rt-amz">—</b><span>Amazon</span></div>
<div class="kpi"><b id="kpi-rt-tag">—</b><span>com tag</span></div>
</div>
<div class="panel">
<div class="panel-head"><span><b id="tit-rastreio">🎯 Rastreio</b> — tudo que foi publicado, com o link de afiliado</span><a class="lk-mini" href="#" onclick="renomearCard('rastreio');return false">✏️ renomear</a></div>
<div class="hint">Cada linha é uma oferta que o Alcance publicou (Piloto ou Monitor) com o <b>link exato</b> publicado. Use para conferir o que saiu e cruzar com o painel de comissão do programa (na Amazon, a <b>tag</b> é o que credita a venda).</div>
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px">
<select id="rtprograma" onchange="carregarRastreio()"><option value="">Todos os programas</option>
<option value="ml">Mercado Livre</option><option value="amazon">Amazon</option>
<option value="shopee">Shopee</option><option value="kabum">KaBuM</option></select>
<select id="rtvia" onchange="carregarRastreio()"><option value="">Piloto + Monitor</option>
<option value="piloto">Piloto</option><option value="monitor">Monitor</option></select>
<select id="rtdias" onchange="carregarRastreio()"><option value="">Todo o histórico</option>
<option value="1">Últimas 24h</option><option value="7">Últimos 7 dias</option>
<option value="30">Últimos 30 dias</option></select>
<button class="mbtn" onclick="carregarRastreio()">🔄</button>
<button class="mbtn ok" onclick="exportarRastreio()">⬇️ Exportar CSV</button>
<span class="mini" id="rtinfo"></span></div>
<div id="rtlista" style="margin-top:10px;font-size:13px"></div>
</div>
</section>
<section class="view" id="view-clientes" data-view="clientes">
<div class="kpis">
<div class="kpi"><b id="kpi-contatos">—</b><span>contatos</span></div>
<div class="kpi"><b id="kpi-listas">—</b><span>listas</span></div>
<div class="kpi warn"><b id="kpi-clifila">—</b><span>fila de envio</span></div>
</div>
<div class="panel ac-clientes">
<div class="panel-head"><span><b id="tit-clientes">👥 Clientes</b></span><a class="lk-mini" href="#" onclick="renomearCard('clientes');return false">✏️ renomear</a></div>
<div class="hint">Contatos puxados dos <b>grupos do seu celular</b> + cadastro manual. Selecione e dispare uma propaganda <b>individual</b> (não é grupo). A fila envia 1 por vez para não parecer robô.</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
<button class="mbtn ok" onclick="syncClientes()">🔄 Puxar contatos dos grupos</button>
<span class="mini" id="clisync"></span></div>
<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
<input id="clinome" placeholder="nome (ex.: João)" style="flex:1;min-width:130px;">
<input id="clifone" placeholder="telefone com DDD" style="flex:1;min-width:130px;">
<button class="mbtn" onclick="addContato()">➕ Contato</button></div>
<div style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap">
<select id="cligrupo" onchange="renderContatos()" style="flex:1;min-width:150px">
  <option value="">👥 Todos os grupos</option>
</select>
<input id="clibusca" placeholder="buscar por nome ou telefone" oninput="renderContatos()" style="flex:1;">
<span class="mini" id="clicount" style="white-space:nowrap"></span></div>
<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
<button class="mbtn" onclick="marcarTodos(true)">☑ Todos</button>
<button class="mbtn" onclick="marcarTodos(false)">☐ Limpar</button>
<button class="mbtn ok" onclick="salvarLista()">💾 Salvar selecionados como lista</button></div>
<div id="cliaddbox" style="margin-top:8px;display:none;gap:6px;align-items:center;flex-wrap:wrap;
  border:1px solid var(--border-strong);border-radius:10px;padding:8px">
  <label style="margin:0">➕ Adicionar selecionados ao grupo:</label>
  <select id="cligrupoalvo" style="flex:1;min-width:150px">
    <option value="">— escolha o grupo —</option>
  </select>
  <button class="mbtn ok" onclick="adicionarAoGrupo()">✔ Adicionar</button>
  <button class="mbtn" onclick="testarBoasVindas()" title="Envia a DM de boas-vindas (imagem + link do TikTok) para um número">🎁 Testar boas-vindas</button>
  <span class="mini" id="cliaddmsg"></span>
  <!-- ===== Opções de boas-vindas ===== -->
  <div style="margin-top:8px;padding:6px 8px;background:var(--card);border-radius:8px;width:100%;box-sizing:border-box">
    <label style="display:block;font-size:11px;color:#8ea0a8;margin-bottom:4px;">Legenda da boas-vindas (DM ao novo membro)</label>
    <textarea id="clilegenda" rows="3" style="width:100%;font-size:12px;" placeholder="Texto que será enviado por DM..."></textarea>
    <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
      <label style="flex:1;cursor:pointer;display:flex;align-items:center;gap:6px;background:var(--card);border:1px solid var(--border-strong);border-radius:6px;padding:6px">
        <input type="file" id="cliimagemInput" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="previewImagemBoasVindas(event)">
        <span class="mbtn" style="width:auto;margin:0" onclick="$('cliimagemInput')?.click()">🖼 Imagem</span>
        <span id="cliimgstatus" class="mini" style="color:#8ea0a8;overflow:hidden;flex:1;text-overflow:ellipsis">padrão</span>
      </label>
      <button class="mbtn" style="width:auto;margin:0" onclick="abrirPreviewBoasVindas()">👁 Preview</button>
    </div>
  </div>
  <!-- Modal de preview -->
  <div id="modalPreview" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center">
    <div style="background:var(--card);border-radius:12px;max-width:400px;width:90%;max-height:90%;overflow:auto;box-shadow:0 4px 24px rgba(0,0,0,.3)">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border-strong);display:flex;justify-content:space-between;align-items:center">
        <b>Preview da boas-vindas</b>
        <button class="mbtn" style="width:auto;margin:0" onclick="$('modalPreview').style.display='none'">✕</button>
      </div>
      <div style="padding:16px">
        <div style="background:#0b141a;border-radius:8px;overflow:hidden;display:flex;flex-direction:column">
          <div style="background:#1f2c34;padding:8px 12px 6px;display:flex;align-items:center;gap:10px">
            <div style="width:32px;height:32px;border-radius:50%;background:#ffd400;border:1px solid #2a3942"></div>
            <div style="flex:1">
              <div style="color:#e9edef;font-weight:600;font-size:14px">Mano dos Achadinhos</div>
              <div style="color:#8696a0;font-size:11px">conta comercial</div>
            </div>
          </div>
          <div style="padding:12px;background:#111b21;display:flex;gap:12px">
            <div id="previewImgContainer" style="flex:1;text-align:center">
              <img id="previewImg" src="/image/Mano%20dos%20Achadinhos_%20Ofertas%20Tech%20e%20Lifestyle.png" alt="Imagem boas-vindas" style="max-width:100%;max-height:120px;border-radius:6px" />
            </div>
          </div>
          <div style="padding:10px 12px;background:#182229">
            <div id="previewLegenda" style="font-size:13px;color:#e9edef;line-height:1.4;white-space:pre-wrap;word-wrap:break-word">
                🎉 <b>Bem-vindo ao Mano dos Achadinhos!</b>

As melhores ofertas de <b>tech, beleza, games e casa</b>, todos os dias, com desconto real e link direto.

🛒 Ofertas selecionadas
🚚 Entrega segura
✅ Compra confiável

Me segue no TikTok:
👉 https://www.tiktok.com/@mano.dos.achadinh

Tem achadinho novo todos os dias. 🔥
            </div>
          </div>
        </div>
      </div>
      <div style="padding:12px 16px 16px;border-top:1px solid var(--border-strong)">
        <button class="mbtn ok" style="width:auto;margin:0 4px" onclick="salvarImagemBoasVindas()">💾 Salvar imagem</button>
        <button class="mbtn" style="width:auto;margin:0 4px" onclick="resetarImagemBoasVindas()">↺ Padrão</button>
        <button class="mbtn" style="width:auto;margin:0" onclick="$('modalPreview').style.display='none'">Fechar</button>
      </div>
    </div>
  </div>
</div>
<div id="clilist" style="max-height:240px;overflow:auto;border:1px solid var(--border-strong);border-radius:10px;padding:4px;margin-top:8px"></div>
<div id="clilistas" style="margin-top:10px;font-size:13px"></div>
<!-- ===== Enviar para uma lista salva (link + imagem/vídeo) ===== -->
<div class="mbox" style="margin-top:12px">
<label>📤 Enviar para uma lista salva</label>
<select id="dlista" style="width:100%"><option value="">— escolha a lista —</option></select>
<textarea id="dtexto" rows="3" style="width:100%;margin-top:6px" placeholder="Mensagem que cada contato vai receber…"></textarea>
<input id="dlink" placeholder="Link (opcional)" style="width:100%;margin-top:6px">
<label style="display:block;margin-top:8px;font-size:12px;">Número que envia</label>
<select id="dinstancia" style="width:100%"><option value="">Automático (rodízio)</option></select>
<span class="mini" id="dinstanciastatus">automático: o rodízio escolhe entre os números liberados para Disparo</span>
<div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
<input type="file" id="dmedia" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4" style="display:none" onchange="escolherMidiaDisparo(event)">
<button class="mbtn" style="width:auto;margin:0" onclick="$('dmedia')?.click()">📎 Imagem/vídeo</button>
<span class="mini" id="dmediastatus">sem mídia (até 16 MB)</span>
<button class="mbtn" style="width:auto;margin:0" title="remover mídia" onclick="limparMidiaDisparo()">✕</button>
</div>
<div id="dpreview" style="margin-top:6px"></div>
<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
<button class="buscar" style="margin-top:0;width:auto" onclick="enviarParaLista()">🚀 Enviar para a lista</button>
<span class="mini" id="daviso">a fila envia 1 por vez (anti-bloqueio)</span></div>
</div>
<!-- ===== Grid de disparos (CRUD) ===== -->
<div style="margin-top:12px">
<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
<b style="font-size:13px">📊 Disparos</b><span class="mini" id="dresumo"></span></div>
<div id="dgrid" style="overflow-x:auto"></div>
</div>
<div id="modalDisparo" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center;padding:16px">
<div style="background:var(--card);border-radius:12px;max-width:460px;width:100%;padding:16px">
<b>✏️ Editar disparo</b>
<textarea id="dedtexto" rows="4" style="width:100%;margin-top:8px" placeholder="Mensagem"></textarea>
<input id="dedlink" placeholder="Link (opcional)" style="width:100%;margin-top:8px">
<label style="display:block;margin-top:8px;font-size:12px;">Número que envia</label>
<select id="dedinstancia" style="width:100%"><option value="">Automático (rodízio)</option></select>
<div style="display:flex;gap:8px;margin-top:10px">
<button class="mbtn ok" style="width:auto;margin:0" onclick="salvarEdicaoDisparo()">Salvar</button>
<button class="mbtn" style="width:auto;margin:0" onclick="$('modalDisparo').style.display='none'">Cancelar</button>
</div></div></div>
<div class="mbox" style="margin-top:10px">
<label>✉️ Propaganda para a seleção</label>
<textarea id="clitexto" rows="3" style="width:100%;" placeholder="Texto da propaganda (pode colar o link no meio)…"></textarea>
<input id="cliimagem" placeholder="URL da imagem (opcional)" style="width:100%;margin-top:6px;">
<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
<button class="buscar" style="margin-top:0;width:auto" onclick="dispararClientes()">🚀 Disparar</button>
<button class="mbtn" onclick="limparFilaClientesUI()">🗑 Cancelar fila</button>
<button class="mbtn" id="btnPausarFila" onclick="pausarFilaClientesUI()" style="display:none">⏸ Pausar fila</button>
<button class="mbtn ok" id="btnRetomarFila" onclick="retomarFilaClientesUI()" style="display:none">▶️ Retomar fila</button>
<span class="mini" id="clifila"></span></div></div>
</div>
</section>
<section class="view" id="view-mensageria" data-view="mensageria">
<div id="msgErroBox"></div>
<div class="kpis" id="msgKpis"></div>
<div class="panel ac-monitor">
<div class="panel-head"><span><b id="tit-mensageria">📨 Mensageria</b> — filas, falhas e DLQ da camada de Mensageria</span><span style="display:flex;gap:8px;align-items:center"><button class="mbtn" id="btnMsgRefresh" type="button">🔄 Atualizar</button><a class="lk-mini" href="#" onclick="renomearCard('mensageria');return false">✏️ renomear</a></span></div>
<div class="hint">Snapshot de <code>GET /api/mensageria/stats</code>: <b>tipo</b>, <b>pendentes</b>, <b>processadas</b>, <b>falhas</b>, <b>dlq</b>, <b>maisAntigaEm</b>, <b>idadeFilaMs</b> e <b>taxaErro</b>.</div>
<div id="msgFilasBox"></div>
</div>
<div class="panel">
<div class="panel-head"><span><b>☠️ Falhas (DLQ)</b> — o que falhou de vez: reprocessar, reprocessar tudo ou descartar</span><span class="mini" id="msgDlqInfo"></span></div>
<div class="tabs" id="msgDlqTabs"></div>
<div class="tools">
<select id="msgDlqFiltro" aria-label="Filtrar DLQ por tipo de fila"></select>
<input id="msgDlqBusca" type="search" placeholder="Buscar por chave, origem, erro ou correlationId…" aria-label="Buscar na DLQ">
<button class="mbtn danger" id="btnMsgReproAll">♻️ Reprocessar tudo</button>
</div>
<div id="msgDlqBox"></div>
</div>
<div class="grid2b">
<div class="panel ac-clientes">
<div class="panel-head"><span><b>🧭 Tópicos e assinantes</b> — fila pendente de cada assinante</span></div>
<div class="hint">De <code>GET /api/mensageria/eventos</code> → <code>assinantes: [{ tipo, nome, pendentes }]</code>.</div>
<div id="msgTopicosBox"></div>
</div>
<div class="panel">
<div class="panel-head"><span><b>🧾 Eventos recentes</b> — auditoria por <code>correlationId</code></span></div>
<div class="hint">De <code>GET /api/mensageria/eventos</code>. Clique em 🔗 para abrir a trilha de correlação.</div>
<div id="msgEventosBox"></div>
</div>
</div>
</section>
</main>
</div>
<div class="mods" id="msgMod" role="dialog" aria-modal="true" aria-labelledby="msgModTitle">
<div class="mod" id="msgModCard">
<div class="mod-h"><b id="msgModTitle">Confirmar</b></div>
<div class="mod-b" id="msgModBody"></div>
<div class="mod-f">
<button class="mbtn" id="msgModCancel" type="button">Cancelar</button>
<button class="mbtn ok" id="msgModOk" type="button">Confirmar</button>
</div>
</div>
</div>
<aside class="drawer" id="msgDrawer" aria-label="Trilha de correlação">
<div class="drawer-h">
<div><div class="top-kicker">trilha de correlação</div><b id="msgDrTitle" style="font-size:14px;display:block;margin-top:2px">—</b></div>
<button class="sair-btn" id="msgDrClose" type="button">Fechar</button>
</div>
<div class="drawer-b" id="msgDrBody"></div>
<div class="drawer-f"><button class="mbtn ok" id="msgDrRepro" type="button">♻️ Reprocessar este item</button></div>
</aside>
<div class="toasts" id="msgToasts" aria-live="polite" aria-atomic="false"></div>
<script>
const $=id=>document.getElementById(id);
// ===== Navegação por views (hash routing) =====
const VIEW_META={
  contas:{k:'configuração',t:'Contas & vínculos',s:'Etiquetas de afiliado, mapeamento categoria → conta/grupo e grupos padrão.'},
  cupons:{k:'configuração',t:'Cupons',s:'Códigos digitáveis por categoria — anexados sozinhos nas mensagens quando existirem.'},
  piloto:{k:'operação',t:'Piloto automático',s:'Caça ofertas por categoria e publica sozinho no grupo amarrado, com rodízio de links.'},
  monitor:{k:'operação',t:'Monitor',s:'Cada grupo de origem encaminha para os seus destinos, com troca de link e anti-rajada.'},
  numeros:{k:'infraestrutura',t:'Números',s:'Celulares de envio rotativo — sorteio ponderado entre ativos e conectados.'},
  clientes:{k:'crescimento',t:'Clientes',s:'Contatos dos grupos + disparo individual com fila anti-bloqueio.'},
  rastreio:{k:'operação',t:'Rastreio',s:'Tudo que o Alcance publicou (Piloto + Monitor) com o link de afiliado — para cruzar com o painel de comissão.'},
  mensageria:{k:'operação',t:'Mensageria',s:'Filas, falhas e DLQ — o que falhou de vez se repara aqui, com um clique.'}
};
function viewAtual(){
  const partes=(location.hash||'').replace('#','').split('/');
  const h=partes[1]||partes[0]||'';
  return VIEW_META[h]?h:'monitor';
}
function navegar(){
  const v=viewAtual();
  document.querySelectorAll('.view').forEach(function(el){el.classList.toggle('active',el.id==='view-'+v);});
  document.querySelectorAll('.side-card').forEach(function(a){
    const on=a.getAttribute('data-view')===v;
    a.classList.toggle('active',on);
    if(on)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  });
  const m=VIEW_META[v];
  $('top-kicker').textContent=m.k;
  $('top-title').textContent=m.t;
  $('top-sub').textContent=m.s;
  document.title='Alcance — '+m.t;
  window.scrollTo(0,0);
  if(v==='rastreio')carregarRastreio();
  if(v==='clientes')carregarSeletorNumero();
  if(v==='mensageria'&&typeof carregarMensageria==='function')carregarMensageria();
  if(v==='piloto'&&$('paprograma')&&$('paprograma').value==='amazon')trocarProgramaPiloto();
}
window.addEventListener('hashchange',navegar);
navegar();
// Sessão: 401 em qualquer chamada devolve para o login.
(function(){
  const ofetch=window.fetch.bind(window);
  window.fetch=async function(u,opt){
    const r=await ofetch(u,opt);
    if(r.status===401)window.location.replace('/login');
    return r;
  };
})();
const btnSair=$('sair');
if(btnSair)btnSair.addEventListener('click',async function(){
  try{await fetch('/api/auth/logout',{method:'POST'});}catch(e){}
  window.location.replace('/login');
});
fetch('/api/categorias').then(r=>r.json()).then(cs=>{
  $('mapcat').innerHTML=cs.map(c=>\`<option value="\${esc(c.id)}">\${esc(c.name)}</option>\`).join('');
  $('pacat').innerHTML=cs.map(c=>\`<option value="\${esc(c.id)}">\${esc(c.name)}</option>\`).join('');
  carregarContas();
  carregarGrupos();
  carregarVitrine();
  carregarCupons();
  carregarMonitorUI();
  carregarTitulos();
  atualizarPiloto();
  carregarClientes();
  carregarSeletorNumero();
  setInterval(function(){try{carregarMonitorStatus();}catch(e){}},15000);
  setInterval(function(){try{carregarClientes();}catch(e){}},15000);
});
let CS=[];
async function carregarVitrine(){
  const d=await (await fetch('/api/vitrine')).json();
  CS=d.items||[];
  if(!d.ok){$('vitrineout').textContent='⚠️ '+(d.erro||'vitrine indisponível');return;}
  const cats=await (await fetch('/api/categorias')).json();
  const opts=cats.map(function(c){return '<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';}).join('');
  let html='<b>'+esc(d.total)+'</b> ofertas reais. Amarre a folha à sua categoria:<br>';
  (d.folhas||[]).forEach(function(f,i){
    html+='<div style="display:flex;gap:8px;margin-top:6px;align-items:center"><span style="flex:2">'+esc(f.leaf)+' ('+esc(f.qtd)+' itens — '+esc(String(f.exemplo).slice(0,40))+'…)</span>'
      +'<select id="vmap'+i+'" style="flex:2">'+opts+'</select>'
      +'<button class="buscar" style="margin-top:0;width:auto" data-leaf="'+esc(f.leaf)+'" data-i="'+esc(i)+'" onclick="salvarVitrineMapBtn(this)">✔</button></div>';
  });
  $('vitrineout').innerHTML=html;
  (d.folhas||[]).forEach(function(f,i){
    if(d.mapa&&d.mapa[f.leaf])document.getElementById('vmap'+i).value=d.mapa[f.leaf];
  });
}
async function salvarVitrineMapBtn(btn){
  salvarVitrineMap(btn.getAttribute('data-leaf'), Number(btn.getAttribute('data-i')));
}
async function salvarVitrineMap(leaf,i){
  await fetch('/api/vitrine/map',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({leaf:leaf,category:document.getElementById('vmap'+i).value})});
  alert('Vitrine amarrada: '+leaf+'.');
  carregarVitrine();
}
async function carregarContas(){
  const d=await (await fetch('/api/contas')).json();
  const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
  kp('kpi-contas',(d.contas||[]).length);kp('badge-contas',(d.contas||[]).length);
  const opts=d.contas.map(c=>\`<option value="\${esc(c.nome)}">\${esc(c.nome)} (\${esc(c.tagMask)})\${c.padrao?' ★':''}</option>\`).join('');
  $('paconta').innerHTML=opts;
  $('mapconta').innerHTML='<option value="-">Padrão</option>'+opts;
  $('contasout').innerHTML=d.contas.map(c=>\`\${c.padrao?'★':'•'} <b>\${esc(c.nome)}</b> <small>\${esc(c.tagMask)}</small> <a href="#" class="lk-mini" data-conta="\${esc(c.nome)}">tornar padrão</a>\`).join('<br>')||'Nenhuma conta — usando .env.';
  if(d.mapa&&d.mapa[$('mapcat').value]){const m=d.mapa[$('mapcat').value];$('mapconta').value=m.conta||'-';if(m.grupo)$('mapgrupo').value=m.grupo;if(m.sub)window._mapsub=m.sub;}
  carregarGrupos();carregarSubs('mapcat','mapsub',true);carregarSubs('pacat','pasub',false);
}
let _gruposEm=0, _gruposCarregando=false;
async function carregarGrupos(forcar){
  if(_gruposCarregando)return;
  if(!forcar && Date.now()-_gruposEm<60000 && $('pagrupo').options.length>1)return;
  _gruposCarregando=true;
  $('pagrupo').innerHTML='<option value="">— carregando grupos… (pode levar 10s)</option>';
  try{
    const g=await (await fetch('/api/grupos'+(forcar?'?refresh=1':''))).json();
    let opts=(g.grupos||[]).map(function(x){return '<option value="'+esc(x.id)+'">'+esc(x.nome)+' ('+esc(String(x.id).slice(0,12))+'…)</option>';}).join('');
    if(g.aviso)$('pagrupo').innerHTML='<option value="">⚠️ '+esc(g.aviso)+'</option>';
    $('mapgrupo').innerHTML='<option value="">Grupo padrão (.env)</option>'+opts;
    $('pagrupo').innerHTML='<option value="">— escolha o grupo —</option>'+opts;
    if(g.aviso)$('pagrupo').innerHTML+='<option value="" disabled>⚠️ '+esc(g.aviso)+'</option>';
    // A aba Monitor usa a MESMA lista (vem do cache, sem chamar a Evolution de novo)
    if($('mselOrigem')&&$('mselOrigem').options.length<=1){
      $('mselOrigem').innerHTML='<option value="">— escolha a origem —</option>'+opts;
      $('mselDestino').innerHTML='<option value="">— escolha o destino —</option>'+opts;
      $('mselPermissao').innerHTML='<option value="">— escolha o grupo —</option>'+opts;
      window.__wgrupos=(g.grupos||[]).map(function(x){return {jid:x.id,nome:x.nome,tamanho:x.tamanho};});
      $('mgruposinfo').textContent=(g.grupos||[]).length+' grupos carregados'+(g.deCache?' (lista salva)':'');
    }
    _gruposEm=Date.now();
  }catch(e){
    $('pagrupo').innerHTML='<option value="">⚠️ erro ao carregar — clique para tentar de novo</option>';
  }finally{_gruposCarregando=false;atualizarPiloto();}
}
['pagrupo','mapgrupo'].forEach(function(id){
  const el=$(id); if(!el)return;
  el.addEventListener('focus',function(){ if(el.options.length<=1) carregarGrupos(true); });
});
setInterval(atualizarPiloto, 10000);
async function atualizarPiloto(){
  try{
    const s=await (await fetch('/api/piloto')).json();
    const n=(s.loops||[]).length;
    const env=(s.loops||[]).reduce(function(a,l){return a+(l.enviadas||0)},0);
    const ult=(s.loops||[]).map(function(l){return l.ultimaMsg||''}).sort().pop()||'';
    const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
    kp('kpi-loops',n+'/20');kp('kpi-piloto-env',env);kp('kpi-piloto-ult',ult?horaLocal(ult):'—');kp('badge-piloto',n);
    let html=n? '' : '⚪ nenhum loop — monte acima e aperte START.';
    // loops que existiam mas estão parados (ex.: pausa de segurança no reinício)
    const parados=(s.loops||[]).filter(function(l){return !l.rodando;});
    if(parados.length){
      html+='<div class="malerta warn" style="margin:8px 0">⏸ <b>'+parados.length+' loop(s) parados</b> — nada está sendo publicado por eles. Clique em <b>▶ START</b> (ou <b>▶ LIGA TUDO</b>) para religar. Se o container reiniciou, o piloto pausa tudo por segurança (defina <b>PILOTO_AUTORELIGA=1</b> para religar sozinho).</div>';
    }
    (s.loops||[]).forEach(function(l){
      html+='<div style="border:1px solid var(--border-strong);border-radius:10px;padding:8px;margin:6px 0;font-size:12.5px'+(l.rodando?'':';opacity:.75')+'">'
        +'<b>#'+esc(l.id)+'</b> '+esc(l.conta)+' → '+esc(l.category)+' → '+esc(String(l.grupo).slice(0,20))+'… '
        +(l.programa&&l.programa!=='ml'?'['+esc(l.programa)+'] ':'')
        +'• enviadas: <b>'+esc(l.enviadas)+'</b>'
        +(l.ultimaMsg?' • última: '+horaLocal(l.ultimaMsg):'')
        +(l.proximaEm?' • próxima: '+horaLocal(l.proximaEm):'')
        +(l.rodando?'':' <span class="mini">(parado)</span>')
        +(l.rodando?'':' <button class="mbtn ok" style="width:auto;padding:4px 10px;margin:0" onclick="pilotoReligarUI('+l.id+')">▶ religar</button>')
        +' <button class="ghost" style="width:auto;padding:4px 10px;margin:0" onclick="pilotoStop('+l.id+')">⏹</button></div>';
    });
    // configs salvas de loops parados: religar sem redigitar nada
    (s.presets||[]).forEach(function(p,i){
      html+='<div style="border:1px dashed var(--border-strong);border-radius:10px;padding:6px 8px;margin:6px 0;font-size:12.5px;opacity:.85">'
        +'<b>⏸ config salva</b> '+esc(p.conta||'(mapa)')+' → '+esc(p.category)+(p.sub?('/'+esc(p.sub)):'')+' → '+esc(String(p.grupo).slice(0,20))+'…'
        +(p.programa&&p.programa!=='ml'?' ['+esc(p.programa)+']':'')
        +' <button class="mbtn ok" style="width:auto;padding:4px 10px;margin:0" onclick="pilotoReligarUI('+i+')">▶ religar</button></div>';
    });
    html+='<div style="margin-top:6px"><b>'+n+'/20 loops</b> <button class="ghost" style="width:auto;padding:4px 10px" onclick="pilotoStopAll()">⏹ parar todos</button></div>';
    $('pstatus').innerHTML=html;
    $('plog').textContent=(s.logs||[]).join('\\n')||'—';
  }catch(e){/* api acordando */}
}
async function pilotoStart(){
  const r=await (await fetch('/api/piloto/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conta:$('paconta').value,category:$('pacat').value,grupo:$('pagrupo').value,sub:$('pasub').value,qtd:Number($('paqtd').value),intervaloS:Number($('pagap').value),filtro:($('pafiltro')?$('pafiltro').value:''),programa:$('paprograma')?$('paprograma').value:'ml'})})).json();
  if(r.erro)return alert(r.erro);
  alert('Loop #'+r.loop.id+' ligado! Primeiras mensagens em segundos, depois 2 a cada 5 min (pausa 8 min/hora).');
  atualizarPiloto();carregarCesta();
}
function horaLocal(iso){try{return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}catch(e){return '';}}
async function pilotoReligarUI(id){
  const r=await (await fetch('/api/piloto/religar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(id)})})).json();
  if(r.erro)return alert(r.erro);
  atualizarPiloto();
}
async function pilotoStop(id){
  await fetch('/api/piloto/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
  atualizarPiloto();
}
async function pilotoStopAll(){
  if(!confirm('Parar todos os loops?'))return;
  await fetch('/api/piloto/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  atualizarPiloto();
}
async function ligaTudo(){
  if(!confirm('Ligar piloto automático para TODAS as categorias amarradas?'))return;
  const r=await (await fetch('/api/auto/ligar',{method:'POST'})).json();
  if(r.erro)return alert(r.erro);
  let msg='Ligado: '+r.ligados.length+' loop(s).';
  if(r.pulados&&r.pulados.length)msg+=' Pulados: '+r.pulados.join('; ');
  alert(msg);
  atualizarPiloto();
}
async function carregarCesta(){
  const cat=$('pacat').value;
  const d=await (await fetch('/api/cesta?category='+encodeURIComponent(cat))).json();
  $('cestainfo').innerHTML='<b>'+(d.items||[]).length+'</b> links na cesta de '+cat;
}
$('pacat').addEventListener('change',function(){carregarCesta();carregarSubs('pacat','pasub');});
$('mapcat').addEventListener('change',function(){carregarSubs('mapcat','mapsub',true);carregarCupons();});
async function aplicarSubSalva(){
  try{
    const d=await (await fetch('/api/contas')).json();
    const m=(d.mapa||{})[$('mapcat').value];
    if(m&&m.sub)$('mapsub').value=m.sub;
    if(window._mapsub){$('mapsub').value=window._mapsub;window._mapsub=null;}
  }catch(e){}
}
async function carregarSubs(catId,selId,comPadrao){
  const sel=$(selId);
  sel.innerHTML='<option value="">carregando…</option>';
  try{
    const d=await (await fetch('/api/subcategorias?category='+encodeURIComponent($(catId).value))).json();
    let html=comPadrao?'<option value="">Sem filtro (categoria inteira)</option>':'<option value="">Categoria inteira</option>';
    (d.items||[]).forEach(function(x){html+='<option value="'+x.id+'">'+x.name+'</option>';});
    sel.innerHTML=html;
    if(selId==='mapsub')aplicarSubSalva();
  }catch(e){ sel.innerHTML='<option value="">(falha ao listar)</option>'; }
}
async function salvarCestaUI(){
  const r=await (await fetch('/api/cesta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:$('pacat').value,texto:$('cestatext').value})})).json();
  if(r.erro)return alert(r.erro);
  $('cestatext').value='';carregarCesta();alert(r.novos+' novo(s), '+r.atualizados+' atualizado(s).');
}
async function limparCestaUI(){
  if(!confirm('Apagar a cesta desta categoria?'))return;
  await fetch('/api/cesta/limpar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:$('pacat').value})});
  carregarCesta();
}
async function salvarContaUI(){
  const r=await (await fetch('/api/contas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:$('cnome').value,tag:$('ctag').value,cookie:$('ccookie').value})})).json();
  if(r.erro)return alert(r.erro);
  $('cnome').value=$('ctag').value=$('ccookie').value='';carregarContas();
}
async function tornarPadrao(nome){
  await fetch('/api/contas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'padrao',nome})});
  carregarContas();
}
async function carregarCupons(){
  try{
    const cat=$('mapcat').value;
    const d=await (await fetch('/api/cupons?category='+encodeURIComponent(cat))).json();
    let html='<b>Registrados:</b> ';
    const regs=Object.entries(d.registrados||{});
    const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
    kp('kpi-cuponsn',regs.length);kp('badge-cupons',regs.length);
    kp('kpi-cupons-reg',regs.length);kp('kpi-cupons-ml',(d.paraCategoria||[]).length);
    html+=regs.length?regs.map(function(e){const v=(typeof e[1]==='string')?{codigo:e[1],nome:''}:e[1];return esc(e[0])+'=<b>'+esc(v.codigo)+'</b>'+(v.nome?' ('+esc(v.nome)+')':'');}).join(' · '):'nenhum';
    html+='<br><b>ML p/ esta categoria:</b> ';
    html+=(d.paraCategoria||[]).map(function(c){return esc(c.titulo)+(c.minimo?' ('+esc(c.minimo)+')':'');}).join(' · ')||'—';
    if(d.codigo)html+='<br>Ativo aqui: <b>'+esc(d.codigo)+'</b>';
    $('cuponsout').innerHTML=html;
    const ml=(d.paraCategoria||[]).slice(0,3).map(function(c){return c.titulo;}).join(' · ');
    $('cuponsml').textContent=ml?('Na vitrine ML agora: '+ml):'';
  }catch(e){}
}
async function salvarCupomUI(){
  const r=await (await fetch('/api/cupons',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chave:$('cpchave').value,codigo:$('cpcode').value,nome:$('cpnome').value})})).json();
  if(r.erro)return alert(r.erro);
  $('cpchave').value=$('cpcode').value=$('cpnome').value='';carregarCupons();
}
async function salvarMapa(){
  await fetch('/api/mapa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:$('mapcat').value,conta:$('mapconta').value,grupo:$('mapgrupo').value,sub:$('mapsub')?$('mapsub').value:''})});
  alert('Mapa salvo: categoria → conta + grupo.');
}
// ---------- E6 MONITOR ----------
async function carregarMonitorUI(){
  try{
    const d=await (await fetch('/api/monitor/grupos')).json();
    renderRegras(d.regras||[]);
    preencherOrigemTeste(d.regras||[]);
    const on=d.autoEnviar===true;
    $('mautolabel').textContent='Envio direto — '+(on?'ON (encaminha sozinho)':'OFF (vai p/ revisão)');
    $('mautobtn').textContent=on?'Desligar envio direto':'Ligar envio direto';
    renderFoto(d.foto||'origem');
    renderMalerta(d.regras||[], on);
    carregarContaMonitor();
    carregarInstancias();
    carregarMonitorStatus();
  }catch(e){}
}
function renderFoto(fonte){
  const origem=fonte!=='produto';
  $('mfotolabel').textContent='Foto do repasse: '+(origem?'a da ORIGEM (mesma do post)':'a do ANÚNCIO (og:image)');
  $('mfotoorigem').className='mbtn'+(origem?' ok':'');
  $('mfotoproduto').className='mbtn'+(!origem?' ok':'');
}
async function definirFotoUI(fonte){
  const r=await (await fetch('/api/monitor/foto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({foto:fonte})})).json();
  if(r.erro)return alert(r.erro);
  renderFoto(r.foto);
}
// ---------- NUMEROS (rotacao) ----------
async function carregarInstancias(){
  try{
    const d=await (await fetch('/api/instancias')).json();
    const itens=d.itens||[];
    const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
    kp('kpi-numerosn',itens.length);kp('kpi-numeros-on',itens.filter(function(i){return i.estado==='open'}).length);kp('badge-numeros',itens.length);
    $('minstmax').textContent='· '+itens.length+'/'+d.max+' · sorteio ponderado';
    preencherOverrides(itens,d.overrides);
    if(!itens.length){$('minstlist').textContent='nenhum número — adicione um.';return;}
    $('minstlist').innerHTML=itens.map(function(i){
      const ic=i.estado==='open'?'🟢':i.estado==='connecting'?'🟡':'🔴';
      const perm=i.permissoes||{piloto:true,monitor:true,disparo:true};
      let acoes='';
      const inst=esc(i.instancia);
      if(i.estado!=='open') acoes+='<button class="mbtn" data-acao="qr" data-inst="'+inst+'">QR</button>';
      acoes+='<button class="mbtn" data-acao="principal" data-valor="'+(i.principal?'false':'true')+'" data-inst="'+inst+'">'+(i.principal?'★ principal':'☆ principal')+'</button>';
      acoes+='<button class="mbtn" data-acao="ativo" data-valor="'+(i.ativo?'false':'true')+'" data-inst="'+inst+'">'+(i.ativo?'desativar':'ativar')+'</button>';
      acoes+='<button class="mbtn" data-acao="peso" data-valor="'+esc(Number(i.peso)||0)+'" data-inst="'+inst+'">peso</button>';
      // permissões por fluxo: botão ligado = número permitido naquele fluxo
      const tog=function(fluxo,rotulo,on){
        return '<button class="mbtn'+(on?' ok':'')+'" data-acao="permissao" data-fluxo="'+fluxo+'" data-valor="'+(on?'false':'true')+'" data-inst="'+inst+'" title="'+(on?'Desligar':'Ligar')+' no fluxo '+rotulo+'">'+rotulo+'</button>';
      };
      acoes+=tog('piloto','Piloto',perm.piloto!==false);
      acoes+=tog('monitor','Monitor',perm.monitor!==false);
      acoes+=tog('disparo','Disparo',perm.disparo!==false);
      acoes+='<button class="mbtn'+(i.pausado?' ok':'')+'" data-acao="pausar" data-valor="'+(i.pausado?'false':'true')+'" data-inst="'+inst+'">'+(i.pausado?'▶ continuar':'⏸ pausar')+'</button>';
      acoes+='<button class="mbtn" data-acao="remover" data-inst="'+inst+'">🗑</button>';
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border)">'+
        '<span>'+esc(i.nome)+' <span class="mini">'+ic+' '+esc(i.estado)+' · peso '+esc(i.peso)+' · '+esc(i.enviadas)+' env'+(i.ativo?'':' · OFF')+(i.pausado?' · ⏸ pausado':'')+(i.emUso?' · em uso':'')+'</span></span>'+
        '<span style="display:flex;gap:4px;flex-wrap:wrap">'+acoes+'</span></div>';
    }).join('');
  }catch(e){}
}
function mostrarQR(qr,nome){
  if(!qr){$('minstqr').innerHTML='<span class="mini">Instância criada. Clique em <b>QR</b> na lista para gerar o código.</span>';return;}
  $('minstqr').innerHTML='<div class="mini">Escaneie com o WhatsApp do <b>'+esc(nome||'novo celular')+'</b> — Aparelhos conectados → Conectar aparelho:</div>'+
    '<img src="'+qr+'" style="width:200px;height:200px;background:#fff;border-radius:8px;margin-top:6px">';
}
async function addInstancia(){
  const nome=$('minstnome').value.trim();
  if(!nome)return alert('Dê um nome (ex.: Celular 2).');
  $('minstqr').innerHTML='<span class="mini">criando instância e gerando QR…</span>';
  const r=await (await fetch('/api/instancias',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nome})})).json();
  if(r.erro){$('minstqr').innerHTML='';return alert(r.erro);}
  $('minstnome').value='';
  mostrarQR(r.qr,r.nome);
  carregarInstancias();
}
async function verQR(inst){
  const r=await (await fetch('/api/instancias/qr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:inst})})).json();
  if(r.erro)return alert(r.erro);
  mostrarQR(r.qr,inst);
}
async function instPrincipal(inst,principal){
  await fetch('/api/instancias/principal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:inst,principal:principal})});
  carregarInstancias();
}
async function instAtivo(inst,ativo){
  await fetch('/api/instancias/ativo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:inst,ativo:ativo})});
  carregarInstancias();
}
async function instPeso(inst,peso){
  const v=prompt('Peso no sorteio (1 a 10). Maior = recebe mais mensagens:',String(peso));
  if(v===null)return;
  await fetch('/api/instancias/peso',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:inst,peso:Number(v)})});
  carregarInstancias();
}
async function instPermissao(inst,fluxo,valor){
  const corpo={instancia:inst};corpo[fluxo]=valor;
  await fetch('/api/instancias/permissoes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corpo)});
  carregarInstancias();
}
async function instPausar(inst,pausado){
  await fetch('/api/instancias/pausar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:inst,pausado:pausado})});
  carregarInstancias();
}
function preencherOverrides(itens,overrides){
  ['piloto','monitor','disparo'].forEach(function(f){
    const sel=$('ov-'+f); if(!sel)return;
    const atual=(overrides&&overrides[f])||'';
    sel.innerHTML='<option value="">Automático</option>'+itens.map(function(i){
      return '<option value="'+esc(i.instancia)+'">'+esc(i.nome)+'</option>';
    }).join('');
    sel.value=atual;
    sel.title=atual?('manual: '+atual):'automático (rodízio)';
  });
}
async function definirOverrideUI(fluxo,valor){
  const r=await (await fetch('/api/instancias/override',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:valor,fluxo:fluxo,valor:valor||null})})).json();
  if(r.erro)return alert(r.erro);
  carregarInstancias();
}
async function instRemover(inst){
  if(!confirm('Remover '+inst+' do cadastro e da Evolution?'))return;
  const r=await (await fetch('/api/instancias/remover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instancia:inst})})).json();
  if(r.erro)return alert(r.erro);
  carregarInstancias();
}
(function(){
  var raiz=document.documentElement;
  var opts=document.querySelectorAll('.tema-opt');
  var nomes={verde:'Verde',laranja:'Laranja',areia:'Areia',grafite:'Grafite',marrom:'Marrom',cacau:'Cacau'};
  var cores={verde:'#047857',laranja:'#c2410c',areia:'#8a6a4f',grafite:'#44403c',marrom:'#7c4a2d',cacau:'#4a2c1d'};
  var lbl=document.getElementById('temaNome');
  var dot=document.getElementById('temaDot');
  var box=document.getElementById('temaBox');
  function aplicar(p){
    if(!nomes[p])p='verde';
    raiz.setAttribute('data-paleta',p);
    for(var i=0;i<opts.length;i++){
      opts[i].setAttribute('aria-pressed', opts[i].getAttribute('data-p')===p ? 'true' : 'false');
    }
    if(lbl)lbl.textContent=nomes[p];
    if(dot)dot.style.background=cores[p];
    try{localStorage.setItem('paleta',p);}catch(e){}
  }
  var salva='verde';
  try{salva=localStorage.getItem('paleta')||'verde';}catch(e){}
  aplicar(salva);
  for(var j=0;j<opts.length;j++){
    opts[j].addEventListener('click',function(){
      aplicar(this.getAttribute('data-p'));
      if(box)box.open=false;
    });
  }
  document.addEventListener('click',function(e){
    if(box&&box.open&&!box.contains(e.target))box.open=false;
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&box&&box.open)box.open=false;
  });
})();
document.addEventListener('click',function(e){
  const a=e.target.closest&&e.target.closest('[data-conta]');
  if(a){e.preventDefault();tornarPadrao(a.getAttribute('data-conta'));}
});
document.addEventListener('click',function(e){
  const b=e.target.closest&&e.target.closest('[data-acao][data-inst]');
  if(!b)return;
  const inst=b.getAttribute('data-inst');
  const acao=b.getAttribute('data-acao');
  if(acao==='qr')verQR(inst);
  else if(acao==='principal')instPrincipal(inst,b.getAttribute('data-valor')==='true');
  else if(acao==='ativo')instAtivo(inst,b.getAttribute('data-valor')==='true');
  else if(acao==='peso')instPeso(inst,Number(b.getAttribute('data-valor'))||0);
  else if(acao==='permissao')instPermissao(inst,b.getAttribute('data-fluxo'),b.getAttribute('data-valor')==='true');
  else if(acao==='pausar')instPausar(inst,b.getAttribute('data-valor')==='true');
  else if(acao==='remover')instRemover(inst);
});
// ---------- TITULOS DOS CARDS ----------
async function carregarTitulos(){
  try{
    const d=await (await fetch('/api/ui')).json();
    const t=d.titulos||{};
    Object.keys(t).forEach(function(k){const el=$('tit-'+k); if(el)el.textContent=t[k];});
  }catch(e){}
}
async function renomearCard(chave){
  const el=$('tit-'+chave);
  const atual=el?el.textContent:'';
  const novo=prompt('Novo nome para este card:',atual);
  if(novo===null)return;
  if(!novo.trim())return alert('nome vazio');
  const r=await (await fetch('/api/ui/titulo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chave:chave,titulo:novo.trim()})})).json();
  if(r.erro)return alert(r.erro);
  if(el)el.textContent=(r.titulos||{})[chave]||novo.trim();
}
// ---------- CLIENTES ----------
let CLIENTES={contatos:[],listas:[],sync:{},fila:{}};
let SELECAO=new Set();
function telFmt(t){const d=String(t||'').replace(/[^0-9]/g,'');return d.length>12?('+'+d.slice(0,2)+' '+d.slice(2,4)+' '+d.slice(4,9)+'-'+d.slice(9)):('+'+d);}
async function carregarClientes(){
  try{
    const d=await (await fetch('/api/clientes')).json();
    CLIENTES=d||{contatos:[],listas:[]};
    const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
    kp('kpi-contatos',(d.contatos||[]).length);kp('kpi-listas',(d.listas||[]).length);kp('badge-clientes',(d.contatos||[]).length);
    const s=d.sync||{};
    $('clisync').textContent = s.rodando
      ? ('puxando… '+(s.feitos||0)+'/'+(s.total||0)+' grupos · '+(s.contatos||0)+' contatos'
        +(s.erros?(' · ⚠️ '+(s.erros)+' grupo(s) com erro (rate limit?)'):''))
      : (s.ultimoSync ? ('último sync: '+new Date(s.ultimoSync).toLocaleString('pt-BR')+' · '+(s.contatos||0)+' contatos'
        +(s.erros?(' · ⚠️ '+(s.erros)+' grupo(s) falharam: '+(s.ultimoErro||'rate limit')):'')) : 'nunca sincronizado');
    const f=d.fila||{};
    $('clifila').textContent='fila: '+(f.pendentes||0)+' pendente(s) · enviados: '+(f.enviados||0)+(f.erros?(' · erros: '+f.erros):'')+' · 1 a cada '+(f.intervalo||60)+'s'+(f.pausado?' · ⏸ PAUSADA':'');
    kp('kpi-clifila',f.pendentes||0);
    // Botões Pausar/Retomar
    const btnPausar=$('btnPausarFila'), btnRetomar=$('btnRetomarFila');
    if(btnPausar && btnRetomar){
      if(f.pendentes>0){
        if(f.pausado){btnPausar.style.display='none'; btnRetomar.style.display='inline-flex';}
        else {btnPausar.style.display='inline-flex'; btnRetomar.style.display='none';}
      }else{
        btnPausar.style.display='none'; btnRetomar.style.display='none';
      }
    }
    // Dropdown de grupos: nomes dos grupos em que os contatos foram capturados.
    const nomesGrupos=[];
    (CLIENTES.contatos||[]).forEach(function(c){
      const o=String(c.origem||'').trim();
      if(o && o!=='manual' && nomesGrupos.indexOf(o)<0) nomesGrupos.push(o);
    });
    nomesGrupos.sort(function(a,b){return a.localeCompare(b,'pt-BR');});
    const grupoSel=$('cligrupo');
    const grupoAtual=grupoSel.value;
    grupoSel.innerHTML='<option value="">👥 Todos os grupos ('+(CLIENTES.contatos||[]).length+')</option>'
      +nomesGrupos.map(function(g){return '<option value="'+esc(g)+'">📍 '+esc(g)+'</option>';}).join('');
    if(nomesGrupos.indexOf(grupoAtual)>=0) grupoSel.value=grupoAtual;
    renderContatos(); renderListas(); renderListasDestino(); renderDisparos();
  }catch(e){}
}
function filtroContatos(){
  const q=($('clibusca').value||'').toLowerCase().trim();
  const g=($('cligrupo').value||'');
  return (CLIENTES.contatos||[]).filter(function(c){
    // Filtro por grupo de origem (nicho): quando há grupo escolhido, só passa
    // quem foi capturado naquele grupo.
    if(g && String(c.origem||'')!==g) return false;
    if(!q)return true;
    return (c.nome||'').toLowerCase().includes(q)||String(c.telefone||'').includes(q);
  });
}
function renderContatos(){
  const arr=filtroContatos(), cap=arr.slice(0,300);
  $('clicount').textContent=SELECAO.size+' sel. · '+arr.length+' contato(s)'+(arr.length>cap.length?(' (mostrando '+cap.length+')'):'');
  if(!cap.length){
    $('clilist').innerHTML='<div class="mini" style="padding:8px">nenhum contato — use <b>Puxar contatos dos grupos</b> ou cadastre 1 acima.</div>';
    return;
  }
  $('clilist').innerHTML=cap.map(function(c){
    const nome=c.nome||telFmt(c.telefone);
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid var(--border)">'
      +'<input type="checkbox" data-sel="'+esc(c.jid)+'"'+(SELECAO.has(c.jid)?' checked':'')+'>'
      +'<span style="flex:1;font-size:13px">'+esc(nome)+(c.nome?(' <span class="mini">'+esc(telFmt(c.telefone))+'</span>'):'')
      +(c.origem?('<br><span class="mini">'+esc(String(c.origem).slice(0,42))+'</span>'):'')+'</span>'
      +'<button class="mbtn" data-act="ren" data-jid="'+esc(c.jid)+'">✏️</button>'
      +'<button class="mbtn" data-act="del" data-jid="'+esc(c.jid)+'">🗑</button></div>';
  }).join('');
}
function renderListas(){
  const ls=CLIENTES.listas||[];
  if(!ls.length){$('clilistas').innerHTML='<span class="mini">nenhuma lista salva</span>';return;}
  $('clilistas').innerHTML='<label>📋 Listas salvas</label>'+ls.map(function(l){
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">'
      +'<span style="flex:1">'+esc(l.nome)+' <span class="mini">'+l.contatos.length+' contato(s)</span></span>'
      +'<button class="mbtn" data-act="sell" data-jid="'+esc(l.id)+'">selecionar</button>'
      +'<button class="mbtn" data-act="dell" data-jid="'+esc(l.id)+'">🗑</button></div>';
  }).join('');
}
// ===== Disparos para lista salva (link + imagem/vídeo) =====
var DMEDIA=null, DMEDIAURL=null, DEDIT=null;
// ===== Seletor de número que envia a campanha (issue #45) =====
var NUMEROS=[];
// Motivo pelo qual o número NÃO pode enviar agora (null = pode enviar).
function numeroBloqueado(i){
  var perm=i.permissoes||{piloto:true,monitor:true,disparo:true};
  if(i.ativo===false)return 'número desativado';
  if(i.pausado)return 'número pausado';
  if(perm.disparo===false)return 'sem permissão Disparo';
  if(i.estado&&i.estado!=='open')return 'conexão '+i.estado;
  return null;
}
// Rótulo com o estado visível (🟢 open / 🟡 connecting / 🔴 close).
function rotuloNumero(i){
  var est=i.estado||'?';
  var ic=est==='open'?'🟢':(est==='connecting'?'🟡':'🔴');
  var txt=esc(i.nome)+' · '+esc(i.instancia)+' · '+ic+' '+esc(est);
  var marcas=[];
  if(i.ativo===false)marcas.push('desativado');
  if(i.pausado)marcas.push('pausado');
  if((i.permissoes||{}).disparo===false)marcas.push('sem permissão Disparo');
  if(marcas.length)txt+=' · '+esc(marcas.join(', '));
  return txt;
}
function preencherSeletorNumero(sel,atual){
  if(!sel)return;
  var opts='<option value="">Automático (rodízio)</option>';
  (NUMEROS||[]).forEach(function(i){
    var motivo=numeroBloqueado(i);
    var rot=rotuloNumero(i)+(motivo?' — não pode enviar ('+esc(motivo)+')':'');
    opts+='<option value="'+esc(i.instancia)+'"'+(motivo?' disabled':'')+' title="'+esc(motivo||'pode enviar')+'">'+rot+'</option>';
  });
  sel.innerHTML=opts;
  sel.value=atual||'';
  sel.title=atual?('número fixado: '+atual):'automático (rodízio)';
  if(sel.id==='dinstancia'){
    var st=$('dinstanciastatus');
    if(st)st.textContent=atual
      ? ('envia pelo número fixado: '+atual+' — se ele cair, volta ao automático')
      : 'automático: o rodízio escolhe entre os números liberados para Disparo';
  }
}
async function carregarSeletorNumero(){
  try{
    var d=await (await fetch('/api/instancias')).json();
    NUMEROS=(d&&d.itens)||[];
  }catch(e){ NUMEROS=[]; }
  preencherSeletorNumero($('dinstancia'), $('dinstancia')?$('dinstancia').value:'');
  preencherSeletorNumero($('dedinstancia'), $('dedinstancia')?$('dedinstancia').value:'');
}
function renderListasDestino(){
  var sel=$('dlista'); if(!sel)return;
  var atual=sel.value, ls=CLIENTES.listas||[];
  sel.innerHTML='<option value="">— escolha a lista —</option>'+ls.map(function(l){
    return '<option value="'+esc(l.id)+'">'+esc(l.nome)+' ('+l.contatos.length+')</option>';
  }).join('');
  if(ls.some(function(l){return l.id===atual;}))sel.value=atual;
}
var DCHIP={PENDENTE:'#b7791f',ENVIANDO:'#0e7490',CONCLUIDO:'#15803d',PARCIAL:'#b45309',ERRO:'#b91c1c',CANCELADO:'#5b6b73'};
function renderDisparos(){
  var arr=CLIENTES.disparos||[], r=CLIENTES.disparosResumo||{};
  if($('dresumo'))$('dresumo').textContent=(r.total||0)+' disparo(s) · '+(r.enviados||0)+' enviado(s) · '+(r.falhas||0)+' falha(s)';
  var box=$('dgrid'); if(!box)return;
  box.onclick=function(ev){
    var b=ev.target&&ev.target.closest?ev.target.closest('button[data-dact]'):null; if(!b)return;
    var id=b.getAttribute('data-id'), act=b.getAttribute('data-dact');
    if(act==='ed')editarDisparo(id);
    else if(act==='dup')duplicarDisparo(id);
    else if(act==='del')excluirDisparo(id);
  };
  if(!arr.length){box.innerHTML='<div class="mini" style="padding:8px">nenhum disparo ainda — o primeiro envio aparece aqui.</div>';return;}
  box.innerHTML='<div style="min-width:900px">'
    +'<div style="display:flex;gap:8px;padding:4px 2px;border-bottom:1px solid var(--border-strong);font-size:11px;color:#5b6b73">'
    +'<span style="width:118px">quando</span><span style="width:140px">lista</span><span style="flex:1">mensagem</span>'
    +'<span style="width:150px">número</span>'
    +'<span style="width:76px">mídia</span><span style="width:92px">status</span><span style="width:96px">envios</span><span style="width:104px"></span></div>'
    +arr.map(function(d){
      var cor=DCHIP[d.status]||'#5b6b73';
      var m=d.midia?(d.midia.tipo==='video'?'🎬 vídeo':'🖼 imagem'):'—';
      var pode=d.status==='PENDENTE'&&!d.enviados&&!d.falhas;
      var num=d.instancia?esc(d.instancia):'Automático';
      return '<div style="display:flex;gap:8px;padding:5px 2px;border-bottom:1px solid var(--border);align-items:center">'
        +'<span class="mini" style="width:118px;white-space:nowrap">'+esc(new Date(d.em).toLocaleString('pt-BR'))+'</span>'
        +'<span style="width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(d.listaNome||'')+'">'+esc(d.listaNome||'—')+' <span class="mini">'+d.total+'</span></span>'
        +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(d.texto||'')+'">'+esc((d.texto||'').slice(0,60)||'(sem texto)')+(d.link?' <span class="mini">🔗</span>':'')+'</span>'
        +'<span class="mini" style="width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(d.instancia||'Automático (rodízio)')+'">'+num+'</span>'
        +'<span class="mini" style="width:76px">'+m+'</span>'
        +'<span style="width:92px;color:'+cor+';font-weight:700;font-size:11px">'+esc(d.status)+'</span>'
        +'<span class="mini" style="width:96px">'+d.enviados+'/'+d.total+(d.falhas?' · '+d.falhas+'✗':'')+'</span>'
        +'<span style="width:104px;display:flex;gap:4px">'
        +(pode?'<button class="mbtn" style="width:auto;margin:0" title="editar" data-dact="ed" data-id="'+esc(d.id)+'">✏️</button>':'')
        +'<button class="mbtn" style="width:auto;margin:0" title="duplicar e reenviar" data-dact="dup" data-id="'+esc(d.id)+'">⧉</button>'
        +'<button class="mbtn" style="width:auto;margin:0" title="excluir" data-dact="del" data-id="'+esc(d.id)+'">🗑</button>'
        +'</span></div>';
    }).join('')+'</div>';
}
function escolherMidiaDisparo(ev){
  var f=ev&&ev.target&&ev.target.files?ev.target.files[0]:null; if(!f)return;
  if(f.size>16*1024*1024){alert('Arquivo acima de 16 MB — use um vídeo/imagem menor.');ev.target.value='';return;}
  if(!/^(image\\/(png|jpe?g|webp|gif)|video\\/mp4)$/.test(f.type)){alert('Formato não suportado: use JPG, PNG, WEBP, GIF ou MP4.');ev.target.value='';return;}
  DMEDIA=f;
  if(DMEDIAURL)URL.revokeObjectURL(DMEDIAURL);
  DMEDIAURL=URL.createObjectURL(f);
  $('dmediastatus').textContent=(f.type.indexOf('video')===0?'vídeo · ':'imagem · ')+f.name+' ('+Math.round(f.size/1024)+' KB)';
  $('dpreview').innerHTML=(f.type.indexOf('video')===0
    ? '<video src="'+DMEDIAURL+'" controls muted playsinline style="max-width:240px;max-height:150px;border-radius:8px"></video>'
    : '<img src="'+DMEDIAURL+'" alt="prévia" style="max-width:240px;max-height:150px;border-radius:8px">');
}
function limparMidiaDisparo(){
  DMEDIA=null; if(DMEDIAURL){URL.revokeObjectURL(DMEDIAURL);DMEDIAURL=null;}
  if($('dmedia'))$('dmedia').value='';
  if($('dmediastatus'))$('dmediastatus').textContent='sem mídia (até 16 MB)';
  if($('dpreview'))$('dpreview').innerHTML='';
}
function arquivoBase64(f){
  return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result||''));};r.onerror=rej;r.readAsDataURL(f);});
}
async function enviarParaLista(){
  var listaId=$('dlista').value, texto=$('dtexto').value.trim(), link=$('dlink').value.trim();
  if(!listaId){alert('Escolha uma lista salva.');return;}
  if(!texto&&!DMEDIA){alert('Escreva a mensagem ou escolha uma imagem/vídeo.');return;}
  var av=$('daviso'); av.textContent='enviando…';
  try{
    var midia=null;
    if(DMEDIA){
      var b64=await arquivoBase64(DMEDIA);
      var up=await (await fetch('/api/clientes/midia',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base64:b64,filename:DMEDIA.name,mimetype:DMEDIA.type})})).json();
      if(up.erro)throw new Error(up.erro);
      midia={arquivo:up.arquivo,mime:up.mime,tipo:up.tipo,nome:up.nome};
    }
    var inst=$('dinstancia')?$('dinstancia').value:'';
    var r=await (await fetch('/api/disparos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({listaId:listaId,texto:texto,link:link,midia:midia,instancia:inst||null})})).json();
    if(r.erro)throw new Error(r.erro);
    $('dtexto').value=''; $('dlink').value=''; limparMidiaDisparo();
    av.textContent='na fila — acompanhe no grid abaixo';
    carregarClientes();
  }catch(e){ av.textContent='erro: '+String(e&&e.message?e.message:e); }
}
function editarDisparo(id){
  var d=(CLIENTES.disparos||[]).filter(function(x){return x.id===id;})[0]; if(!d)return;
  if(d.status!=='PENDENTE'||d.enviados||d.falhas){alert('Só dá para editar disparo ainda não enviado. Use ⧉ para reenviar.');return;}
  DEDIT=id; $('dedtexto').value=d.texto||''; $('dedlink').value=d.link||'';
  preencherSeletorNumero($('dedinstancia'), d.instancia||'');
  $('modalDisparo').style.display='flex';
}
async function salvarEdicaoDisparo(){
  var id=DEDIT; if(!id)return;
  var inst=$('dedinstancia')?$('dedinstancia').value:'';
  var r=await (await fetch('/api/disparos/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto:$('dedtexto').value,link:$('dedlink').value,instancia:inst||null})})).json();
  if(r.erro){alert(r.erro);return;}
  $('modalDisparo').style.display='none'; DEDIT=null; carregarClientes();
}
async function duplicarDisparo(id){
  var r=await (await fetch('/api/disparos/'+encodeURIComponent(id)+'/duplicar',{method:'POST'})).json();
  if(r.erro){alert(r.erro);return;}
  carregarClientes();
}
async function excluirDisparo(id){
  if(!confirm('Excluir este disparo? Itens ainda na fila saem; o que já foi enviado não voltar.'))return;
  var r=await (await fetch('/api/disparos/'+encodeURIComponent(id),{method:'DELETE'})).json();
  if(r.erro){alert(r.erro);return;}
  carregarClientes();
}
// ===== Rastreio (publicações) =====
async function carregarRastreio(){
  const q=[];
  if($('rtprograma').value)q.push('programa='+encodeURIComponent($('rtprograma').value));
  if($('rtvia').value)q.push('via='+encodeURIComponent($('rtvia').value));
  if($('rtdias').value)q.push('dias='+$('rtdias').value);
  const url='/api/rastreio'+(q.length?('?'+q.join('&')):'');
  try{
    const d=await (await fetch(url)).json();
    const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
    kp('kpi-rt-total',d.total||0);
    kp('kpi-rt-ml',(d.porPrograma&&d.porPrograma.ml)||0);
    kp('kpi-rt-amz',(d.porPrograma&&d.porPrograma.amazon)||0);
    kp('kpi-rt-tag',d.comTag||0);
    kp('badge-rastreio',d.total||0);
    const ps=d.publicacoes||[];
    const limiteInfo=(typeof d.armazenados==='number')?(' · armazenados: '+d.armazenados+' / '+(d.limite||'?')):'';
    $('rtinfo').textContent=ps.length+' publicação(ões) listada(s)'+limiteInfo;
    if(!ps.length){$('rtlista').innerHTML='<div class="mini">Nada publicado ainda neste filtro.</div>';return;}
    $('rtlista').innerHTML='<div style="display:flex;flex-direction:column;gap:4px">'+ps.map(function(p){
      return '<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">'
        +'<span class="mini" style="white-space:nowrap">'+esc(new Date(p.em).toLocaleString('pt-BR'))+'</span>'
        +'<span class="mini" style="min-width:58px">'+esc(p.programa)+'</span>'
        +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.titulo||p.id)+'</span>'
        +'<span class="mini">'+esc(p.categoria)+'</span>'
        +(p.tag?('<span class="mini">tag: '+esc(p.tag)+'</span>'):'')
        +'<a class="lk-mini" href="'+esc(linkSeguro(p.link))+'" target="_blank" rel="noopener">abrir</a></div>';
    }).join('')+'</div>';
  }catch(e){$('rtinfo').textContent='erro: '+e.message;}
}
function exportarRastreio(){
  const q=[];
  if($('rtprograma').value)q.push('programa='+encodeURIComponent($('rtprograma').value));
  if($('rtvia').value)q.push('via='+encodeURIComponent($('rtvia').value));
  if($('rtdias').value)q.push('dias='+$('rtdias').value);
  q.push('csv=1');
  window.location='/api/rastreio?'+q.join('&');
}
// ===== Piloto: troca de programa (ML <-> Amazon) =====
async function trocarProgramaPiloto(){
  const prog=$('paprograma').value;
  const box=$('pamazoninfo');
  const selCat=$('pacat');
  const resp=await (await fetch('/api/categorias?programa='+encodeURIComponent(prog))).json();
  selCat.innerHTML=resp.map(function(c){return '<option value="'+esc(c.id)+'">'+esc(c.name)+' ('+esc(c.id)+')</option>';}).join('');
  const subBox=$('pmlsubbox');
  if(subBox)subBox.style.display=prog==='amazon'?'none':'block';
  if(prog==='amazon'){
    box.style.display='block';
    const st=await (await fetch('/api/amazon/status')).json();
    box.innerHTML='Amazon: a caça usa a <b>Creators API</b> (searchItems).'
      +(st.credenciais?'<span style="color:var(--ok-tx)">✓ credenciais OK</span>':' <b>⚠️ faltam AMAZON_CREATORS_ID/SECRET</b> — sem isso a caça fica inerte')
      +(st.tag?'<span style="color:var(--ok-tx)">✓ tag de comissão</span>':' <b>⚠️ sem AMAZON_TAG o link não paga comissão</b>')
      +' · '+st.categorias+' categorias.';
  }else{
    box.style.display='none';
  }
}
async function syncClientes(){
  $('clisync').textContent='iniciando… (leva alguns minutos: o WhatsApp limita consultas em rajada)';
  const r=await (await fetch('/api/clientes/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)return alert(r.erro);
  carregarClientes();
}
async function addContato(){
  const nome=$('clinome').value.trim(), fone=$('clifone').value.trim();
  if(!fone)return alert('informe o telefone com DDD');
  const r=await (await fetch('/api/clientes/contato',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nome,telefone:fone})})).json();
  if(r.erro)return alert(r.erro);
  $('clinome').value='';$('clifone').value='';
  carregarClientes();
}
function marcarTodos(on){
  const arr=filtroContatos();
  if(on)arr.forEach(function(c){SELECAO.add(c.jid);});
  else SELECAO.clear();
  renderContatos();
  atualizarCaixaAdicionar();
}
async function salvarLista(){
  if(!SELECAO.size)return alert('selecione pelo menos 1 contato');
  const nome=prompt('Nome da lista:','Lista '+(new Date().toLocaleDateString('pt-BR')));
  if(!nome||!nome.trim())return;
  const r=await (await fetch('/api/clientes/lista',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nome.trim(),contatos:[...SELECAO]})})).json();
  if(r.erro)return alert(r.erro);
  carregarClientes();
}
async function dispararClientes(){
  if(!SELECAO.size)return alert('selecione pelo menos 1 contato');
  const texto=$('clitexto').value.trim();
  if(!texto)return alert('escreva a propaganda');
  const imagem=$('cliimagem').value.trim();
  if(!confirm('Disparar para '+SELECAO.size+' contato(s)? A fila envia 1 por vez.'))return;
  const r=await (await fetch('/api/clientes/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto:texto,imagem:imagem,jids:[...SELECAO]})})).json();
  if(r.erro)return alert(r.erro);
  carregarClientes();
}
async function limparFilaClientesUI(){
  if(!confirm('Cancelar a fila de disparo? O que já saiu não volta.'))return;
  const r=await (await fetch('/api/clientes/fila/limpar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)return alert(r.erro);
  carregarClientes();
}
async function pausarFilaClientesUI(){
  const r=await (await fetch('/api/clientes/fila/pausar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)return alert(r.erro);
  carregarClientes();
}
async function retomarFilaClientesUI(){
  const r=await (await fetch('/api/clientes/fila/retomar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)return alert(r.erro);
  carregarClientes();
}
// ===== Adicionar contatos selecionados a um grupo =====
let _gruposAlvoCarregados=false;
async function carregarGruposAlvo(){
  const sel=$('cligrupoalvo');
  sel.innerHTML='<option value="">— carregando grupos…</option>';
  try{
    const g=await (await fetch('/api/grupos')).json();
    const opts=(g.grupos||[]).map(function(x){
      return '<option value="'+esc(x.id)+'">'+esc(x.nome)+' ('+(x.tamanho!=null?x.tamanho+'participantes':esc(String(x.id).slice(0,12))+'…')+')</option>';
    }).join('');
    sel.innerHTML='<option value="">— escolha o grupo —</option>'+opts;
    _gruposAlvoCarregados=true;
    if(g.aviso)$('cliaddmsg').textContent=g.aviso;
  }catch(e){
    sel.innerHTML='<option value="">⚠️ erro ao carregar grupos</option>';
  }
}
function atualizarCaixaAdicionar(){
  const box=$('cliaddbox');
  const tem=SELECAO.size>0;
  box.style.display=tem?'flex':'none';
  if(tem && !_gruposAlvoCarregados) carregarGruposAlvo();
  // Não limpa a mensagem aqui: o texto de sucesso ("N adicionado(s)") precisa
  // continuar visível depois que a seleção é zerada.
}
async function adicionarAoGrupo(){
  const grupo=$('cligrupoalvo').value;
  if(!grupo)return alert('escolha o grupo de destino');
  if(!SELECAO.size)return alert('selecione pelo menos 1 contato');
  const nomeGrupo=$('cligrupoalvo').options[$('cligrupoalvo').selectedIndex].textContent;
  if(!confirm('Adicionar '+SELECAO.size+' contato(s) em "'+nomeGrupo+'"?\\n\\nSó funciona se esta conta for ADMIN do grupo e o grupo tiver link de convite ativo.\\n\\nO envio é feito um a um (o WhatsApp limita adições em rajada) e pode levar alguns minutos.'))return;
  $('cliaddmsg').innerHTML='<span class="mini">iniciando…</span>';
  const legendaOverride=$('clilegenda')?.value?.trim();
  const body = {grupoJid:grupo,jids:[...SELECAO]};
  if(legendaOverride || caminhoImagemBoasVindas){
    body.legendaOverride = {};
    if(legendaOverride) body.legendaOverride.legenda = legendaOverride;
    if(caminhoImagemBoasVindas) body.legendaOverride.imagem = caminhoImagemBoasVindas;
  }
  const r=await (await fetch('/api/clientes/grupo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  if(r.erro){$('cliaddmsg').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(r.erro)+'</span>';return;}
  SELECAO.clear();
  renderContatos();
  atualizarCaixaAdicionar();
  await acompanharAdicaoGrupo();
}
// Teste manual da DM de boas-vindas (mesma mensagem enviada após o add).
async function testarBoasVindas(){
  const numero=prompt('Número com DDD para receber a boas-vindas (ex.: 5511999999999):');
  if(!numero)return;
  $('cliaddmsg').innerHTML='<span class="mini">enviando boas-vindas…</span>';
  try{
    const r=await (await fetch('/api/clientes/boas-vindas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numero:numero.trim(),forcar:true})})).json();
    if(r.ok)$('cliaddmsg').innerHTML='<span style="color:var(--ok-tx)">boas-vindas enviada ✓</span> <span class="mini">('+esc(r.numero||'')+')</span>';
    else $('cliaddmsg').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(r.erro||'falha no envio')+'</span>';
  }catch(e){
    $('cliaddmsg').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(String(e))+'</span>';
  }
}
// ===== Preview e upload de imagem de boas-vindas =====
let caminhoImagemBoasVindas = null; // null = padrão, ou caminho relativo
function previewImagemBoasVindas(event){
  const file = event?.target?.files?.[0];
  if(!file)return;
  const preview = $('previewImg');
  if(!preview)return;
  const url = URL.createObjectURL(file);
  preview.src = url;
  $('cliimgstatus').textContent = 'Arquivo: '+file.name;
  // Atualiza preview legenda também
  atualizarPreviewLegenda();
}
async function salvarImagemBoasVindas(){
  const file = $('cliimagemInput')?.files?.[0];
  if(!file)return alert('Selecione uma imagem primeiro');
  const preview = $('previewImg');
  if(!preview)return alert('Imagem não carregada');
  $('cliaddmsg').innerHTML='<span class="mini">salvando imagem…</span>';
  try{
    // Converte para base64
    const reader = new FileReader();
    reader.onload = async function(e){
      const base64 = e.target.result;
      const r = await (await fetch('/api/clientes/boas-vindas/upload',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({base64, filename: file.name})
      })).json();
      if(r.ok){
        caminhoImagemBoasVindas = r.caminho;
        $('cliimgstatus').textContent = 'Usando: '+r.caminho;
        alert('Imagem salva com sucesso! Agora clique em "Abrir" para preview.');
        // Atualiza preview com a imagem salva
        preview.src = '/'+r.caminho+'?t='+Date.now();
      }else{
        $('cliaddmsg').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(r.erro||'falha no upload')+'</span>';
      }
    };
    reader.readAsDataURL(file);
  }catch(e){
    $('cliaddmsg').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(String(e))+'</span>';
  }
}
async function resetarImagemBoasVindas(){
  // Remove a imagem customizada e volta ao padrão
  try{
    const r = await (await fetch('/api/clientes/boas-vindas/upload',{method:'DELETE'})).json();
    caminhoImagemBoasVindas = null;
    $('cliimgstatus').textContent = 'padrão';
    const preview = $('previewImg');
    if(preview) preview.src = '/image/Mano%20dos%20Achadinhos_%20Ofertas%20Tech%20e%20Lifestyle.png';
    alert('Imagem redefinida ao padrão');
  }catch(e){
    alert('Erro ao redefinir: '+String(e));
  }
}
function abrirPreviewBoasVindas(){
  const modal = $('modalPreview');
  if(!modal)return;
  // Carrega legenda padrão ou customizada
  const legendaCustom = $('clilegenda')?.value?.trim();
  const previewLegenda = $('previewLegenda');
  const previewImg = $('previewImg');
  if(previewLegenda){
    previewLegenda.textContent = legendaCustom || "🎉 *Bem-vindo ao Mano dos Achadinhos!*\\n\\nAs melhores ofertas de *tech, beleza, games e casa*, todos os dias, com desconto real e link direto.\\n\\n🛒 Ofertas selecionadas\\n🚚 Entrega segura\\n✅ Compra confiável\\n\\nMe segue no TikTok:\\n👉 https://www.tiktok.com/@mano.dos.achadinh\\n\\nTem achadinho novo todos os dias. 🔥";
  }
  // Atualiza imagem se houver customizada
  if(previewImg && caminhoImagemBoasVindas){
    previewImg.src = '/'+caminhoImagemBoasVindas+'?t='+Date.now();
  }
  modal.style.display = 'flex';
}
function atualizarPreviewLegenda(){
  const legendaCustom = $('clilegenda')?.value?.trim();
  const previewLegenda = $('previewLegenda');
  if(!previewLegenda)return;
  if(legendaCustom){
    previewLegenda.textContent = legendaCustom;
  }else{
    previewLegenda.textContent = "🎉 *Bem-vindo ao Mano dos Achadinhos!*\\n\\nAs melhores ofertas de *tech, beleza, games e casa*, todos os dias, com desconto real e link direto.\\n\\n🛒 Ofertas selecionadas\\n🚚 Entrega segura\\n✅ Compra confiável\\n\\nMe segue no TikTok:\\n👉 https://www.tiktok.com/@mano.dos.achadinh\\n\\nTem achadinho novo todos os dias. 🔥";
  }
}
// Carrega legenda padrão na inicialização
window.addEventListener('DOMContentLoaded', function(){
  const legendaDefault = "🎉 *Bem-vindo ao Mano dos Achadinhos!*\\n\\nAs melhores ofertas de *tech, beleza, games e casa*, todos os dias, com desconto real e link direto.\\n\\n🛒 Ofertas selecionadas\\n🚚 Entrega segura\\n✅ Compra confiável\\n\\nMe segue no TikTok:\\n👉 https://www.tiktok.com/@mano.dos.achadinh\\n\\nTem achadinho novo todos os dias. 🔥";
  if($('clilegenda'))$('clilegenda').value = legendaDefault;
  // Se já existe imagem customizada salva (data/bw-custom.png), reflete no preview
  // e passa a usá-la como override nas adições desta sessão.
  fetch('/data/bw-custom.png',{method:'HEAD'}).then(function(r){
    if(!r.ok)return;
    caminhoImagemBoasVindas='data/bw-custom.png';
    const p=$('previewImg'); if(p)p.src='/data/bw-custom.png?t='+Date.now();
    const st=$('cliimgstatus'); if(st)st.textContent='customizada';
  }).catch(function(){});
});
// Acompanha o job em background (a adição é 1 por vez e pode levar minutos).
async function acompanharAdicaoGrupo(){
  for(let i=0;i<600;i++){
    const d=await (await fetch('/api/clientes/grupo/status')).json();
    const j=d.job||{};
    if(j.rodando){
      const extra=j.limitado?' · ⚠️ WhatsApp limitou, aguardando janela livre':'';
      const btn=j.pausado
        ?'<button class="mini" onclick="retomarAdicaoGrupoUI()" style="margin-left:8px">▶ resume</button>'
        :'<button class="mini" onclick="pausarAdicaoGrupoUI()" style="margin-left:8px">⏸ pausa</button>';
      $('cliaddmsg').innerHTML='<span class="mini">adicionando… '+j.feitos+'/'+j.total+' · '+j.adicionados+' no grupo'+(j.jaNoGrupo?(' · '+j.jaNoGrupo+' já estavam'):'')+(j.boasVindas?(' · '+j.boasVindas+' boas-vindas'):'')+extra+btn;
      await new Promise(r=>setTimeout(r,2000));
      continue;
    }
    if(j.total>0){
      const extra=j.limitado?' <span style="color:var(--danger-tx)">· o WhatsApp limitou algumas adições</span>':'';
      $('cliaddmsg').innerHTML='<span style="color:var(--ok-tx)">'+j.adicionados+' adicionado(s) ✓</span>'
      +(j.jaNoGrupo?(' <span class="mini">· '+j.jaNoGrupo+' já estavam no grupo</span>'):'')
      +(j.boasVindas?(' <span class="mini">· '+j.boasVindas+' boas-vindas</span>'):'')
      +(j.falhos&&j.falhos.length?(' <span style="color:var(--danger-tx)">· '+j.falhos.length+' não entraram</span>'):'')
      +extra;
      return;
    }
    return;
  }
}
async function pausarAdicaoGrupoUI(){
  const r=await (await fetch('/api/clientes/grupo/pausar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)alert(r.erro);
  carregarClientes();
}
async function retomarAdicaoGrupoUI(){
  const r=await (await fetch('/api/clientes/grupo/retomar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)alert(r.erro);
  carregarClientes();
}
$('clilist').addEventListener('change',function(ev){
  const el=ev.target;
  if(el && el.getAttribute && el.getAttribute('data-sel')){
    const jid=el.getAttribute('data-sel');
    if(el.checked)SELECAO.add(jid); else SELECAO.delete(jid);
    $('clicount').textContent=SELECAO.size+' sel.';
    atualizarCaixaAdicionar();
  }
});
$('clilist').addEventListener('click',async function(ev){
  const b=ev.target.closest('[data-act]');
  if(!b)return;
  const act=b.getAttribute('data-act'), jid=b.getAttribute('data-jid');
  if(act==='ren'){
    const c=(CLIENTES.contatos||[]).find(function(x){return x.jid===jid;})||{};
    const nome=prompt('Nome do contato:',c.nome||'');
    if(nome===null)return;
    await fetch('/api/clientes/contato/renomear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:jid,nome:nome})});
    carregarClientes();
  }else if(act==='del'){
    if(!confirm('Remover este contato?'))return;
    await fetch('/api/clientes/contato/remover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:jid})});
    SELECAO.delete(jid);
    carregarClientes();
  }
});
$('clilistas').addEventListener('click',async function(ev){
  const b=ev.target.closest('[data-act]');
  if(!b)return;
  const act=b.getAttribute('data-act'), id=b.getAttribute('data-jid');
  const l=(CLIENTES.listas||[]).find(function(x){return x.id===id;});
  if(act==='sell'&&l){
    SELECAO=new Set(l.contatos);
    renderContatos();
    $('clitexto').scrollIntoView({behavior:'smooth',block:'center'});
  }else if(act==='dell'&&l){
    if(!confirm('Remover a lista "'+l.nome+'"? (os contatos continuam cadastrados)'))return;
    await fetch('/api/clientes/lista/remover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
    carregarClientes();
  }
});
function renderRegras(regras){
  $('mregrasn').textContent=regras.length?('· '+regras.length):'';
  if(!regras.length){$('mregras').innerHTML='<div class="mini" style="padding:6px 0">nenhuma regra ainda — monte a primeira acima.</div>';return;}
  $('mregras').innerHTML=regras.map(function(r){
    const dests=r.destinos.length?r.destinos.map(function(d){
      return '<div class="dest'+(d.ativo?'':' off')+'"><span>→ <b>'+esc(d.nome)+'</b> <span class="jidtag">'+esc(d.jid)+'</span></span>'
        +'<span class="ctrls">'
        +'<button class="tgl'+(d.ativo?' on':'')+'" title="ligar/desligar este destino" data-o="'+esc(r.origem.jid)+'" data-d="'+esc(d.jid)+'" onclick="toggleDestinoUI(this)">'+(d.ativo?'ON':'OFF')+'</button>'
        +'<button class="mbtn" style="padding:3px 8px;font-size:11px" data-o="'+esc(r.origem.jid)+'" data-d="'+esc(d.jid)+'" onclick="removerDestinoUI(this)">✕</button>'
        +'</span></div>';
    }).join(''):'<div class="dest mini">⚠️ sem destino — esta origem não encaminha nada</div>';
    return '<div class="regra'+(r.origem.ativo?'':' off')+'"><div class="orig"><span>🔎 <b>'+esc(r.origem.nome)+'</b> <span class="jidtag">'+esc(r.origem.jid)+'</span></span>'
      +'<span class="ctrls">'
      +'<button class="tgl'+(r.origem.ativo?' on':'')+'" title="ligar/desligar esta origem" data-o="'+esc(r.origem.jid)+'" onclick="toggleOrigemUI(this)">'+(r.origem.ativo?'ON':'OFF')+'</button>'
      +'<button class="mbtn" style="padding:3px 8px;font-size:11px" data-o="'+esc(r.origem.jid)+'" onclick="removerRegraUI(this)">✕ origem</button>'
      +'</span></div>'+dests+'</div>';
  }).join('');
}
// Alerta: deixa explícito que regra ligada NÃO envia se o "envio direto" estiver OFF.
function renderMalerta(regras,auto){
  const el=$('malerta'); if(!el) return;
  const ativas=regras.filter(function(r){return r.origem.ativo && r.destinos.some(function(d){return d.ativo;});});
  if(!auto && ativas.length){
    el.innerHTML='<div class="malerta pare">⛔ <b>Envio direto DESLIGADO</b> — você tem <b>'+ativas.length+' regra(s) ligada(s)</b>, mas <b>nada será enviado</b> (tudo cai em revisão). Clique em <b>“Ligar envio direto”</b> acima para começar a reenviar.</div>';
  } else if(auto && !ativas.length){
    el.innerHTML='<div class="malerta warn">⚠️ <b>Envio direto LIGADO</b>, mas nenhuma regra está ativa — ligue a <b>origem</b> E o <b>destino</b> (toggle ON) para reenviar.</div>';
  } else if(auto){
    el.innerHTML='<div class="malerta ok">✅ Reenviando automaticamente — <b>'+ativas.length+'</b> regra(s) ativa(s).</div>';
  } else { el.innerHTML=''; }
}
async function carregarContaMonitor(){
  try{
    const d=await (await fetch('/api/monitor/conta')).json();
    const ok=d.estado==='open';
    $('mcontalabel').textContent='Conta WhatsApp: '+(d.nome||d.jid||'—')+(d.jid?' ('+d.jid.replace(/@.*/,'')+')':'');
    const r=d.remetente||{modo:'automatico',elegiveis:[]};
    let envio;
    if(r.modo==='fixo'){
      envio='Envio: <b>fixo</b> em <b>'+esc(r.fixada||'?')+'</b> (aba Números → Remetente por fluxo)';
    }else if((r.elegiveis||[]).length){
      envio='Envio: <b>automático</b> — rodízio entre '+r.elegiveis.length+' número(s) liberado(s) para Monitor: '+r.elegiveis.map(function(i){return esc(i.nome);}).join(', ');
    }else{
      envio='<span style="color:var(--danger-tx)">Envio: <b>nenhum número liberado para Monitor</b> — ative a permissão na aba Números</span>';
    }
    $('mcontaestado').innerHTML=(ok?'🟢 conectada':'🔴 '+esc(d.estado||'?'))+' • '+envio+'<br><span class="mini">operações de serviço (adicionar contatos): '+esc(d.instancia)+'</span>';
  }catch(e){}
}
function irParaNumeros(){ location.hash='#/numeros'; }
async function carregarGruposSelects(forcar){
  $('mgruposinfo').textContent='buscando grupos… (a Evolution leva 10-30s; se o WhatsApp limitar, mostramos a última lista salva)';
  try{
    const d=await (await fetch('/api/monitor/whats-grupos'+(forcar?'?forcar=1':''))).json();
    const aviso=d.aviso?(' · '+d.aviso):'';
    if(!d.ok&&!(d.grupos||[]).length){$('mgruposinfo').innerHTML='<span style="color:var(--danger-tx)">'+esc(d.erro||'erro')+esc(aviso)+'</span>';return;}
    window.__wgrupos=d.grupos||[];
    const opts=window.__wgrupos.map(function(g){return '<option value="'+esc(g.jid)+'">'+esc(g.nome)+(g.tamanho!=null?' ('+g.tamanho+')':'')+'</option>';}).join('');
    $('mselOrigem').innerHTML='<option value="">— escolha a origem —</option>'+opts;
    $('mselDestino').innerHTML='<option value="">— escolha o destino —</option>'+opts;
    $('mselPermissao').innerHTML='<option value="">— escolha o grupo —</option>'+opts;
    $('mgruposinfo').textContent=window.__wgrupos.length+' grupos carregados'+(d.deCache?' (lista salva — Evolution limitada)':'')+aviso;
  }catch(e){$('mgruposinfo').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(e.message)+'</span>';}
}
async function permissaoGrupoUI(acao){
  const sel=$('mselPermissao');
  const jid=sel.value;
  if(!jid)return alert('escolha o grupo');
  const nome=sel.options[sel.selectedIndex].textContent;
  const rotulos={announcement:'só admins podem falar/comentar',not_announcement:'todos podem falar',locked:'só admins editam as informações',unlocked:'todos editam as informações'};
  if(!confirm('Aplicar em "'+nome+'": '+rotulos[acao]+'?'))return;
  $('mpermissaoinfo').textContent='aplicando…';
  const r=await (await fetch('/api/grupos/permissao',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grupoJid:jid,acao:acao})})).json();
  if(r.erro){$('mpermissaoinfo').innerHTML='<span style="color:var(--danger-tx)">erro: '+esc(r.erro)+'</span>';return;}
  const p=r.permissao||{};
  $('mpermissaoinfo').textContent='ok — '+(p.announce?'só admins falam':'todos falam')+' · '+(p.restrict?'só admins editam':'todos editam');
}
async function adicionarRegraUI(){
  const o=$('mselOrigem'), dd=$('mselDestino');
  if(!o.value||!dd.value)return alert('Escolha a origem e o destino.');
  const onome=o.options[o.selectedIndex].textContent, dnome=dd.options[dd.selectedIndex].textContent;
  const r=await (await fetch('/api/monitor/grupos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origemJid:o.value,origemNome:onome,destinoJid:dd.value,destinoNome:dnome})})).json();
  if(r.erro)return alert(r.erro);
  carregarMonitorUI();
}
async function removerRegraUI(el){
  if(!confirm('Remover a regra desta origem (e todos os seus destinos)?'))return;
  await fetch('/api/monitor/grupos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'removerRegra',origemJid:el.dataset.o})});
  carregarMonitorUI();
}
async function removerDestinoUI(el){
  await fetch('/api/monitor/grupos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'removerDestino',origemJid:el.dataset.o,destinoJid:el.dataset.d})});
  carregarMonitorUI();
}
async function toggleOrigemUI(el){
  await fetch('/api/monitor/grupos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'alternarOrigem',origemJid:el.dataset.o})});
  carregarMonitorUI();
}
async function toggleDestinoUI(el){
  await fetch('/api/monitor/grupos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'alternarDestino',origemJid:el.dataset.o,destinoJid:el.dataset.d})});
  carregarMonitorUI();
}
async function reiniciarEvo(){
  if(!confirm('Reconectar o socket da instância (destrava estado preso)?'))return;
  const r=await (await fetch('/api/monitor/reiniciar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)return alert(r.erro);
  alert('Estado: '+r.estado);
  carregarContaMonitor();
}
async function trocarCelular(){
  if(!confirm('DESLOGAR a conta atual para parear outro celular?\\n\\nDepois escaneie o QR com o celular que tem os grupos de afiliados.'))return;
  const r=await (await fetch('/api/monitor/desconectar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if(r.erro)return alert(r.erro);
  alert('Conta deslogada. Abra http://'+location.hostname+':8097 para escanear o QR com o celular correto.');
  carregarContaMonitor();
}
function preencherOrigemTeste(regras){
  $('mtesteorigem').innerHTML='<option value="">primeira origem das regras</option>'+regras.map(function(r){return '<option value="'+esc(r.origem.jid)+'">'+esc(r.origem.nome)+'</option>';}).join('');
}
async function carregarMonitorStatus(){
  try{
    const d=await (await fetch('/api/monitor/status')).json();
    const kp=function(id,v){const el=$(id);if(el)el.textContent=String(v);};
    kp('kpi-origens',d.origens||0);kp('kpi-destinos',d.destinos||0);
    kp('kpi-recebidas',d.recebidas||0);kp('kpi-encaminhadas',d.encaminhadas||0);
    // Diagnóstico de volume: por que as ofertas não chegam no mesmo volume recebido?
    const vol=d.volume||{};
    const box=$('mvolume');
    if(box){
      const naoEnviadas=(d.recebidas||0)-(d.encaminhadas||0);
      box.innerHTML='<label>📊 Volume — '+vol.taxaEncaminhada+'% das ofertas recebidas foram para o grupo</label>'
        +'<div class="mini" style="margin-top:4px">'
        +'recebidas <b>'+(d.recebidas||0)+'</b> → encaminhadas <b>'+(d.encaminhadas||0)+'</b> · '
        +'duplicadas <b>'+(d.duplicadas||0)+'</b> (mesmo produto em 7d) · revisão <b>'+(d.revisao||0)+'</b> (link sem afiliado) · '
        +'dedup: '+vol.dedupDias+'d'+(vol.dedupPorOrigem?' · <b>por origem</b>':' · <b>global</b> (mesmo produto de outra origem não passa)')
        +'</div>';
    }
    kp('kpi-duplicadas',d.duplicadas||0);kp('kpi-revisao',d.revisao||0);
    kp('kpi-erros',d.erros||0);kp('kpi-fila',d.fila||0);
    kp('badge-monitor',d.fila||0);
    $('mstatus').innerHTML='atualizado às <b>'+horaLocal(new Date().toISOString())+'</b>'+(d.erros?(' · <b style="color:var(--danger-tx)">'+d.erros+' erro(s)</b>'):'');
    $('mfila').innerHTML='🚦 fila anti-rajada: <b>'+(d.fila||0)+'</b> em espera · liberando 1 a cada <b>'+(d.intervaloFila||120)+'s</b>'+(d.fila>0?' <span class="mini">(≈ '+Math.ceil((d.fila*(d.intervaloFila||120))/60)+' min p/ esvaziar)</span>':'');
    $('meventos').textContent=(d.eventos||[]).map(e=>horaLocal(e.em)+' ['+e.status+'] '+e.programa+' '+(e.idProduto||'')+' ← '+e.origem+(e.destino?' → '+e.destino:'')+(e.detalhe?' ('+e.detalhe+')':'')).join('\\n')||'(sem eventos)';
    const dot=$('side-dot');if(dot)dot.classList.remove('off');
    const live=$('side-live-txt');if(live)live.textContent='monitor · '+(d.encaminhadas||0)+' encaminhadas';
    const top=$('top-live');if(top)top.textContent='● monitor · '+(d.fila>0?(d.fila+' na fila'):'sem fila');
  }catch(e){const dot=$('side-dot');if(dot)dot.classList.add('off');}
}
async function zerarContadoresUI(){
  if(!confirm('Zerar os contadores do monitor (limpa o histórico de eventos)?\\nAs regras e o dedup continuam.'))return;
  const r=await (await fetch('/api/monitor/zerar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alvo:'contadores'})})).json();
  $('mresetout').textContent=r.erro?('erro: '+r.erro):('contadores zerados ('+(r.removidos||0)+' eventos)');
  carregarMonitorStatus();
}
async function limparDedupUI(){
  if(!confirm('Limpar o dedup?\\nProdutos já enviados PODEM ser reenviados se aparecerem de novo.'))return;
  const r=await (await fetch('/api/monitor/zerar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alvo:'dedup'})})).json();
  $('mresetout').textContent=r.erro?('erro: '+r.erro):('dedup limpo ('+(r.removidos||0)+' registros)');
}
async function limparFilaUI(){
  if(!confirm('Esvaziar a fila?\\nAs mensagens em espera NÃO serão enviadas.'))return;
  const r=await (await fetch('/api/monitor/zerar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alvo:'fila'})})).json();
  $('mresetout').textContent=r.erro?('erro: '+r.erro):('fila esvaziada ('+(r.removidos||0)+' itens)');
  carregarMonitorStatus();
}
async function toggleAutoMonitor(){
  const on=($('mautolabel').textContent||'').indexOf('ON')>=0;
  await fetch('/api/monitor/auto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoEnviar:!on})});
  carregarMonitorUI();
}
async function testarMonitor(){
  const texto=$('mteste').value;
  if(!texto.trim())return alert('Cole uma mensagem de teste.');
  const r=await (await fetch('/api/monitor/testar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto,origem:$('mtesteorigem').value})})).json();
  if(r.erro){$('mtesteout').textContent='erro: '+r.erro;return;}
  $('mtesteout').textContent='programa: '+((r.principal&&r.principal.programa)||'—')+'\\nid: '+((r.principal&&r.principal.id)||'—')+'\\nação: '+r.resultado.acao+(r.resultado.motivo?' ('+r.resultado.motivo+')':'')+(r.mensagem?'\\n\\n--- mensagem que seria enviada ---\\n'+r.mensagem:'');
  carregarMonitorStatus();
}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function linkSeguro(u){try{const x=new URL(String(u||''));return (x.protocol==='http:'||x.protocol==='https:')?x.href:'';}catch(e){return '';}}
</script>
<script>
/* ============================================================
   VIEW MENSAGERIA — filas, DLQ, reprocessar/descartar e trilha
   de correlação (issue #54). Implementação fiel ao protótipo
   aprovado em docs/prototipos/mensageria/opcao-1.html.
   ============================================================ */
var MSG={itens:[],filas:[],eventos:[],acoes:[],assinantes:[],carregando:true,erro:null,filtro:'todas',busca:'',emVoo:false};

function msgNum(n){return Number(n||0).toLocaleString('pt-BR');}
function msgPlural(n,s,p){return Number(n)===1?s:p;}
function msgPct(n){return (Number(n||0)*100).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:2})+'%';}
function msgHum(ms){
  ms=Number(ms||0); if(ms<=0)return '—';
  var s=Math.floor(ms/1000), d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60), ss=s%60;
  if(d>0)return d+'d '+h+'h';
  if(h>0)return h+' h '+m+' min';
  if(m>0)return m+' min';
  return ss+' s';
}
function msgRel(iso){if(!iso)return '—';var ms=Date.now()-Date.parse(iso);if(!isFinite(ms)||ms<0)ms=0;return 'há '+msgHum(ms);}
function msgHhmm(iso){if(!iso)return '—';var d=new Date(iso);if(isNaN(d.getTime()))return '—';return d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function msgDdmm(iso){if(!iso)return '—';var d=new Date(iso);if(isNaN(d.getTime()))return '—';return d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});}

/* ---------- carga ---------- */
async function carregarMensageria(){
  if(MSG.emVoo)return;
  MSG.emVoo=true;
  var primeira=!MSG.itens.length&&!MSG.filas.length;
  if(primeira)MSG.carregando=true;
  msgRender();
  try{
    const rs=await Promise.all([
      fetch('/api/mensageria/stats'),
      fetch('/api/mensageria/dlq'),
      fetch('/api/mensageria/eventos')
    ]);
    const ds=await rs[0].json();
    const dd=await rs[1].json();
    const de=await rs[2].json();
    MSG.filas=ds.filas||[];
    MSG.itens=dd.itens||[];
    MSG.eventos=de.eventos||[];
    MSG.acoes=de.acoes||[];
    MSG.assinantes=de.assinantes||[];
    MSG.erro=null;
  }catch(e){
    MSG.erro='o serviço não respondeu ('+String((e&&e.message)?e.message:e)+')';
  }
  MSG.carregando=false;
  MSG.emVoo=false;
  msgRender();
}

/* ---------- render ---------- */
function msgRender(){msgRenderErro();msgRenderKpis();msgRenderFilas();msgRenderDlq();msgRenderTopicos();msgRenderEventos();msgRenderBadge();}
function msgRenderBadge(){
  const b=$('badge-mensageria');
  if(b)b.textContent=MSG.carregando?'…':String(MSG.itens.length);
}
function msgRenderErro(){
  const box=$('msgErroBox');
  if(!box)return;
  if(!MSG.erro){box.innerHTML='';return;}
  box.innerHTML='<div class="alerta pare"><b>Não foi possível carregar a mensageria.</b><br><span class="mini">'+esc(MSG.erro)+'</span><div style="margin-top:8px"><button class="mbtn" id="btnMsgRetry">🔄 Tentar de novo</button></div></div>';
  const b=$('btnMsgRetry');
  if(b)b.addEventListener('click',function(){MSG.erro=null;carregarMensageria();msgToast('Nova tentativa de carregamento…');});
}
function msgRenderKpis(){
  const box=$('msgKpis');
  if(!box)return;
  if(MSG.carregando){
    box.innerHTML='<div class="kpi"><b class="skel lg" style="display:block;width:56px"></b><span>carregando</span></div>'
      +'<div class="kpi ok"><b class="skel lg" style="display:block;width:56px"></b><span>&nbsp;</span></div>'
      +'<div class="kpi warn"><b class="skel lg" style="display:block;width:56px"></b><span>&nbsp;</span></div>'
      +'<div class="kpi danger"><b class="skel lg" style="display:block;width:56px"></b><span>&nbsp;</span></div>'
      +'<div class="kpi warn"><b class="skel lg" style="display:block;width:56px"></b><span>&nbsp;</span></div>'
      +'<div class="kpi"><b class="skel lg" style="display:block;width:56px"></b><span>&nbsp;</span></div>'
      +'<div class="kpi"><b class="skel lg" style="display:block;width:56px"></b><span>&nbsp;</span></div>';
    return;
  }
  let pend=0,proc=0,falh=0,dlq=0,idade=0;
  MSG.filas.forEach(function(f){
    pend+=Number(f.pendentes||0); proc+=Number(f.processadas||0); falh+=Number(f.falhas||0); dlq+=Number(f.dlq||0);
    if(Number(f.idadeFilaMs||0)>idade)idade=Number(f.idadeFilaMs||0);
  });
  const total=proc+falh, taxa=total>0?Number((falh/total).toFixed(4)):0;
  box.innerHTML=
   '<div class="kpi"><b>'+msgNum(pend)+'</b><span>em fila</span></div>'
   +'<div class="kpi ok"><b>'+msgNum(proc)+'</b><span>processadas (ok)</span></div>'
   +'<div class="kpi warn"><b>'+msgNum(falh)+'</b><span>falhas</span></div>'
   +'<div class="kpi'+(dlq>0?' danger':'')+'"><b>'+msgNum(dlq)+'</b><span>na dlq</span></div>'
   +'<div class="kpi'+(taxa>0.02?' warn':'')+'"><b>'+msgPct(taxa)+'</b><span>taxa de erro</span></div>'
   +'<div class="kpi"><b>'+esc(msgHum(idade))+'</b><span>mais antiga</span></div>'
   +'<div class="kpi"><b>'+msgNum(MSG.assinantes.length)+'</b><span>assinaturas de tópicos</span></div>';
}
function msgRenderFilas(){
  const box=$('msgFilasBox');
  if(!box)return;
  if(MSG.carregando){
    let r='<div class="tblwrap"><table class="tbl"><tbody>';
    for(let i=0;i<3;i++)r+='<tr><td><span class="skel" style="display:block;width:150px"></span></td><td><span class="skel" style="display:block;width:44px"></span></td><td><span class="skel" style="display:block;width:54px"></span></td><td><span class="skel" style="display:block;width:40px"></span></td><td><span class="skel" style="display:block;width:40px"></span></td><td><span class="skel" style="display:block;width:80px"></span></td><td><span class="skel" style="display:block;width:56px"></span></td></tr>';
    box.innerHTML=r+'</tbody></table></div>';
    return;
  }
  if(MSG.erro){box.innerHTML='<div class="empty"><span class="ico">📡</span><b>Sem dados de filas</b><span class="mini">O serviço não respondeu — tente de novo.</span></div>';return;}
  if(!MSG.filas.length){box.innerHTML='<div class="empty"><span class="ico">📚</span><b>Nenhuma fila registrada</b><span class="mini">O snapshot veio sem filas.</span></div>';return;}
  let h='<div class="tblwrap"><table class="tbl"><thead><tr><th>Fila (tipo)</th><th class="num">Pendentes</th><th class="num">Processadas</th><th class="num">Falhas</th><th class="num">DLQ</th><th>Mais antiga</th><th class="num">Taxa de erro</th></tr></thead><tbody>';
  MSG.filas.forEach(function(f){
    const dlq=Number(f.dlq||0);
    h+='<tr><td><span class="badge">'+esc(f.tipo)+'</span></td>'
      +'<td class="num">'+msgNum(f.pendentes)+'</td>'
      +'<td class="num">'+msgNum(f.processadas)+'</td>'
      +'<td class="num">'+msgNum(f.falhas)+'</td>'
      +'<td class="num"><span class="badge" style="background:'+(dlq>0?'var(--danger-soft)':'var(--ok-soft)')+';color:'+(dlq>0?'var(--danger-tx)':'var(--ok-tx)')+';border-color:'+(dlq>0?'var(--danger-bd)':'var(--ok-bd)')+'">'+msgNum(dlq)+'</span></td>'
      +'<td class="nowrap">'+(f.maisAntigaEm?'<span class="mini">'+esc(msgHhmm(f.maisAntigaEm))+'</span><br><span class="mini">'+esc(msgRel(f.maisAntigaEm))+'</span>':'—')+'</td>'
      +'<td class="num">'+msgPct(f.taxaErro)+'</td></tr>';
  });
  h+='</tbody></table></div>';
  let pendTotal=0;MSG.filas.forEach(function(f){pendTotal+=Number(f.pendentes||0);});
  if(pendTotal===0)h+='<div class="alerta ok" style="margin-top:10px"><b>Nenhuma mensagem pendente.</b><br><span class="mini">As filas estão zeradas — nada esperando para ser processado.</span></div>';
  box.innerHTML=h;
}
function msgFiltrados(){
  const q=(MSG.busca||'').toLowerCase().trim();
  return MSG.itens.filter(function(it){
    if(MSG.filtro!=='todas'&&it.tipo!==MSG.filtro)return false;
    if(!q)return true;
    const env=it.envelope||{};
    const hay=[it.id,it.tipo,env.chave||'',it.origem||'',it.ultimoErro||'',env.correlationId||'',it.motivo||''].join(' ').toLowerCase();
    return hay.indexOf(q)>=0;
  });
}
function msgRenderDlq(){
  const box=$('msgDlqBox'),tabs=$('msgDlqTabs'),filtro=$('msgDlqFiltro'),info=$('msgDlqInfo');
  if(!box)return;
  const tipos=['todas'],vistos={};
  MSG.itens.forEach(function(i){if(!vistos[i.tipo]){vistos[i.tipo]=1;tipos.push(i.tipo);}});
  const tot=MSG.itens.length;
  let th='<button class="tab'+(MSG.filtro==='todas'?' on':'')+'" data-msg-f="todas">Todas <span class="cnt">('+tot+')</span></button>';
  tipos.slice(1).forEach(function(t){
    const n=MSG.itens.filter(function(i){return i.tipo===t;}).length;
    th+='<button class="tab'+(MSG.filtro===t?' on':'')+'" data-msg-f="'+esc(t)+'">'+esc(t)+' <span class="cnt">('+n+')</span></button>';
  });
  if(tabs)tabs.innerHTML=th;
  if(filtro){
    let fh='<option value="todas">Todas as filas</option>';
    tipos.slice(1).forEach(function(t){fh+='<option value="'+esc(t)+'"'+(MSG.filtro===t?' selected':'')+'>'+esc(t)+'</option>';});
    filtro.innerHTML=fh;filtro.value=MSG.filtro;
  }
  if(MSG.carregando){if(info)info.textContent='carregando…';box.innerHTML='<div class="tblwrap"><table class="tbl"><tbody><tr><td><span class="skel" style="display:block;width:340px"></span></td><td><span class="skel" style="display:block;width:120px"></span></td><td><span class="skel" style="display:block;width:90px"></span></td><td><span class="skel" style="display:block;width:80px"></span></td></tr></tbody></table></div>';return;}
  if(MSG.erro){if(info)info.textContent='';box.innerHTML='<div class="empty"><span class="ico">📡</span><b>Não foi possível carregar a DLQ</b><span class="mini">O serviço não respondeu — tente de novo.</span></div>';return;}
  const lista=msgFiltrados();
  if(info)info.textContent=tot===0?'nenhum item':(lista.length+' de '+tot+' itens');
  if(!tot){box.innerHTML='<div class="empty"><span class="ico">🎉</span><b>Nada na DLQ</b><span class="mini">Todas as mensagens foram processadas com sucesso. Se algo falhar de vez, ela aparece aqui para você <b>reprocessar</b> ou <b>descartar</b>.</span></div>';return;}
  if(!lista.length){box.innerHTML='<div class="empty"><span class="ico">🔎</span><b>Nenhum item neste filtro</b><span class="mini">Ajuste o tipo de fila ou limpe a busca.</span></div>';return;}
  let t='<div class="tblwrap"><table class="tbl tbl-dlq"><thead><tr><th>Tipo</th><th>Chave / correlação</th><th>Motivo</th><th class="num">Tent.</th><th>Última tent.</th><th>Origem</th><th>Último erro</th><th>Ações</th></tr></thead><tbody>';
  lista.forEach(function(it){
    const env=it.envelope||{}, busy=it.state==='reprocessando';
    const perigo=String(it.motivo||'')==='erro não transitório';
    const corr=env.correlationId||'';
    const chave=env.chave||'';
    const reenvio=env.reenvio||null;
    t+='<tr'+(busy?' class="sel"':'')+'>'
      +'<td class="nowrap"><span class="badge">'+esc(it.tipo)+'</span>'
      +(reenvio?' <span class="badge reenvio" title="Reagendado para reenvio em '+esc(reenvio.agendadoEm||'')+'">↻ reenvio 24h</span>':'')+'</td>'
      +'<td><span class="dlq-chave"><span class="mono trunc" title="'+esc(chave||'—')+'">'+(chave?esc(chave):'—')+'</span>'
      +(chave?' <button class="copybtn" data-msg-act="copy" data-msg-val="'+esc(chave)+'" title="Copiar chave">⧉</button>':'')+'</span>'
      +(corr?'<div class="mini" style="font-family:var(--mono);font-size:10px;margin-top:2px">corr '+esc(corr.slice(0,8))+'…</div>':'')+'</td>'
      +'<td><span class="badge" style="background:'+(perigo?'var(--danger-soft)':'var(--warn-soft)')+';color:'+(perigo?'var(--danger-tx)':'var(--warn-tx)')+';border-color:'+(perigo?'var(--danger-bd)':'var(--warn-bd)')+'">'+esc(it.motivo||'—')+'</span>'+(busy?' <span class="badge mock">reprocessando</span>':'')+'</td>'
      +'<td class="num">'+msgNum(it.tentativas)+'</td>'
      +'<td class="nowrap"><span class="mini">'+esc(msgHhmm(it.ultimaTentativaEm))+'</span><br><span class="mini">'+esc(msgRel(it.ultimaTentativaEm))+'</span></td>'
      +'<td><span class="trunc" title="'+esc(it.origem||'—')+'">'+esc(it.origem||'—')+'</span></td>'
      +'<td><span class="mono trunc" title="'+esc(it.ultimoErro||'')+'">'+esc(it.ultimoErro||'—')+'</span></td>'
      +'<td class="nowrap">'
      +(busy?'<button class="mbtn sm ok" disabled><span class="spin"></span>Reprocessando…</button>'
            :'<button class="mbtn sm ok" data-msg-act="repro" data-msg-id="'+esc(it.id)+'">♻️ Reprocessar</button>')
      +'<button class="mbtn sm danger" data-msg-act="desc" data-msg-id="'+esc(it.id)+'"'+(busy?' disabled':'')+'>🗑 Descartar</button>'
      +(corr?'<button class="mbtn sm" data-msg-act="trail" data-msg-corr="'+esc(corr)+'" title="Ver trilha de correlação">🔗</button>':'')
      +'</td></tr>';
  });
  t+='</tbody></table></div>';
  box.innerHTML=t;
}
function msgRenderTopicos(){
  const box=$('msgTopicosBox');
  if(!box)return;
  if(MSG.carregando){box.innerHTML='<div class="skel" style="display:block;height:120px"></div>';return;}
  if(MSG.erro){box.innerHTML='<div class="empty"><span class="ico">🧭</span><b>Sem dados de tópicos</b><span class="mini">O serviço não respondeu.</span></div>';return;}
  if(!MSG.assinantes.length){box.innerHTML='<div class="empty"><span class="ico">🧭</span><b>Nenhum assinante</b><span class="mini">Nenhum tópico registrado.</span></div>';return;}
  const porTipo={},ordem=[];
  MSG.assinantes.forEach(function(a){if(!porTipo[a.tipo]){porTipo[a.tipo]=[];ordem.push(a.tipo);}porTipo[a.tipo].push(a);});
  let h='<div class="tblwrap"><table class="tbl"><thead><tr><th>Evento (tópico)</th><th>Assinantes</th><th class="num">Pendentes</th></tr></thead><tbody>';
  ordem.forEach(function(t){
    const a=porTipo[t];let p=0;const names=[];
    a.forEach(function(x){p+=Number(x.pendentes||0);names.push(x.nome+' ('+x.pendentes+')');});
    h+='<tr><td class="nowrap"><span class="badge">'+esc(t)+'</span></td><td><span class="mini">'+esc(names.join(' · '))+'</span></td>'
      +'<td class="num">'+(p>0?'<span class="badge" style="background:var(--warn-soft);color:var(--warn-tx);border-color:var(--warn-bd)">'+msgNum(p)+'</span>':'0')+'</td></tr>';
  });
  h+='</tbody></table></div>';
  box.innerHTML=h;
}
function msgRenderEventos(){
  const box=$('msgEventosBox');
  if(!box)return;
  if(MSG.carregando){box.innerHTML='<div class="skel" style="display:block;height:120px"></div>';return;}
  if(MSG.erro){box.innerHTML='<div class="empty"><span class="ico">🧾</span><b>Sem eventos</b><span class="mini">O serviço não respondeu.</span></div>';return;}
  if(!MSG.eventos.length){box.innerHTML='<div class="empty"><span class="ico">🧾</span><b>Nenhum evento</b><span class="mini">A auditoria está vazia.</span></div>';return;}
  let h='<div style="max-height:280px;overflow:auto">';
  MSG.eventos.slice(0,14).forEach(function(e){
    const corr=e.correlationId||'';
    const reenv=String(e.tipo||'').indexOf('reagendada')>=0;
    h+='<div class="evt"><time>'+esc(msgHhmm(e.em))+'</time><span class="badge">'+esc(e.tipo)+'</span>'
      +(reenv?'<span class="badge reenvio" title="Duplicata reagendada para o reenvio">↻ reenvio 24h</span>':'')
      +'<span class="t mono" title="'+esc(e.chave||'')+'">'+esc(e.chave||'—')+'</span>'
      +(corr?'<button class="copybtn" data-msg-act="copy" data-msg-val="'+esc(corr)+'" title="Copiar correlationId">⧉</button>':'')
      +(corr?'<button class="mbtn sm" data-msg-act="trail" data-msg-corr="'+esc(corr)+'" title="Ver trilha">🔗</button>':'')+'</div>';
  });
  h+='</div>';
  box.innerHTML=h;
}

/* ---------- toast / copiar / modal ---------- */
function msgToast(msg,kind){
  const c=$('msgToasts');
  if(!c)return;
  const d=document.createElement('div');
  d.className='toast'+(kind?' '+kind:'');
  d.innerHTML='<span style="flex:0 0 auto">'+(kind==='err'?'✗':kind==='warn'?'⚠':'✓')+'</span><span>'+msg+'</span>';
  c.appendChild(d);
  setTimeout(function(){d.style.opacity='0';d.style.transition='opacity .2s';setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d);},220);},3600);
}
function msgCopiar(txt){
  let ok=false;
  try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt);ok=true;}}catch(e){}
  if(!ok){try{const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);ok=true;}catch(e){}}
  msgToast(ok?'Copiado: <b>'+esc(txt)+'</b>':'Não foi possível copiar — selecione e copie manualmente.',ok?'':'warn');
}
let msgModalCb=null;
function msgAbrirModal(o){
  const t=$('msgModTitle'),b=$('msgModBody'),ok=$('msgModOk'),card=$('msgModCard'),mod=$('msgMod');
  if(!mod)return;
  if(t)t.textContent=o.titulo||'Confirmar';
  if(b)b.innerHTML=o.corpo||'';
  if(ok){ok.textContent=o.ok||'Confirmar';ok.className='mbtn '+(o.perigo?'danger':'ok');}
  if(card)card.className='mod'+(o.perigo?' danger':'');
  msgModalCb=o.aoConfirmar||null;
  mod.classList.add('on');
  if(ok)ok.focus();
}
function msgFecharModal(){const m=$('msgMod');if(m)m.classList.remove('on');msgModalCb=null;}

/* ---------- trilha de correlação ---------- */
function msgPasso(tipo){
  switch(tipo){
    case 'oferta.recebida': return {cls:'mute',st:'publicado'};
    case 'disparo.criado': return {cls:'mute',st:'publicado'};
    case 'disparo.concluido': return {cls:'',st:'processado (ack)'};
    case 'disparo.mensagem.enviada': return {cls:'',st:'processado (ack)'};
    case 'instancia.conectada': return {cls:'mute',st:'infra'};
    case 'instancia.desconectada': return {cls:'mute',st:'infra'};
    case 'mensagem.dlq': return {cls:'bad',st:'falha definitiva → dlq'};
  }
  return {cls:'mute',st:'evento'};
}
function msgPayloadResumo(it){
  const p=(it.envelope&&it.envelope.payload)||{};
  if(it.tipo==='cliente.enviar'){
    return '<dl class="kv" style="margin:0"><dt>jid</dt><dd>'+esc(p.jid||'—')+'</dd><dt>nome</dt><dd>'+esc(p.nome||'—')+'</dd><dt>disparoId</dt><dd>'+esc(p.disparoId||'—')+'</dd><dt>instância</dt><dd>'+esc(p.instancia||'—')+'</dd><dt>texto</dt><dd>'+esc(p.texto||'—')+'</dd></dl>';
  }
  const q=p.item||{};
  return '<dl class="kv" style="margin:0"><dt>origem</dt><dd>'+esc(q.origem||'—')+'</dd><dt>destino</dt><dd>'+esc(p.destino||'—')+'</dd><dt>produto</dt><dd>'+esc(q.idProduto||'—')+'</dd><dt>destinos</dt><dd>'+esc((q.destinos||[]).join(' · ')||'—')+'</dd><dt>mensagem</dt><dd>'+esc(q.mensagem||'—')+'</dd></dl>';
}
async function msgAbrirTrilha(corr){
  if(!corr)return;
  const drawer=$('msgDrawer'),body=$('msgDrBody'),titulo=$('msgDrTitle');
  let evs=[],acs=[];
  try{
    const d=await (await fetch('/api/mensageria/eventos?correlationId='+encodeURIComponent(corr))).json();
    evs=d.eventos||[];acs=d.acoes||[];
  }catch(e){}
  evs=evs.slice().sort(function(a,b){return Date.parse(a.em)-Date.parse(b.em);});
  acs=acs.slice().sort(function(a,b){return Date.parse(a.em)-Date.parse(b.em);});
  let item=null;
  MSG.itens.forEach(function(it){if((it.envelope||{}).correlationId===corr)item=it;});
  if(titulo)titulo.textContent=corr.slice(0,8)+'…';
  let h='<dl class="kv"><dt>correlationId</dt><dd><span class="mono">'+esc(corr)+'</span> <button class="copybtn" data-msg-act="copy" data-msg-val="'+esc(corr)+'" title="Copiar">⧉</button></dd>';
  if(item){
    const env=item.envelope||{};
    h+='<dt>tipo</dt><dd>'+esc(item.tipo)+'</dd>'
      +'<dt>chave</dt><dd>'+(env.chave?'<span class="mono">'+esc(env.chave)+'</span>':'<span class="mini">— (sem chave de idempotência)</span>')+'</dd>'
      +'<dt>tentativas</dt><dd>'+msgNum(item.tentativas)+'</dd>'
      +'<dt>reprocessos</dt><dd>'+msgNum(env.reprocessos||0)+'</dd>'
      +'<dt>origem</dt><dd>'+esc(item.origem||'—')+'</dd>'
      +'<dt>publicado</dt><dd>'+esc(msgDdmm(env.timestamp))+'</dd>'
      +'<dt>última tentativa</dt><dd>'+esc(msgDdmm(item.ultimaTentativaEm))+'</dd>'
      +'<dt>motivo</dt><dd>'+esc(item.motivo||'—')+'</dd>'
      +'<dt>payload</dt><dd>'+msgPayloadResumo(item)+'</dd>';
  }
  h+='</dl>';
  h+='<div class="hint" style="margin-top:14px"><b>Etapas do fluxo</b> — de <code>GET /api/mensageria/eventos?correlationId=…</code> e do item da DLQ.</div>';
  const passos=evs.map(function(e){const m=msgPasso(e.tipo);return {cls:m.cls,st:m.st,titulo:e.tipo,quando:e.em,tent:e.tentativas,chave:e.chave};});
  if(item){
    const falha={cls:'warn',st:'tentativa esgotada',titulo:msgNum(item.tentativas)+' '+msgPlural(item.tentativas,'tentativa','tentativas')+' — '+(item.ultimoErro||'sem erro registrado'),quando:item.ultimaTentativaEm,tent:item.tentativas,chave:(item.envelope||{}).chave||''};
    let idx=-1;
    for(let i=0;i<passos.length;i++){if(passos[i].titulo==='mensagem.dlq'){idx=i;break;}}
    if(idx>=0)passos.splice(idx,0,falha);else passos.push(falha);
  }
  acs.forEach(function(a){
    passos.push({cls:a.acao==='descartar'?'bad':'',st:'ação do operador · '+a.acao,titulo:(a.acao||'ação')+' — '+(a.tipo||''),quando:a.em,tent:a.tentativas||0,chave:a.chave||''});
  });
  h+='<ul class="trail">';
  passos.forEach(function(s){
    h+='<li class="'+s.cls+'"><div class="st">'+esc(s.st)+'</div><b>'+esc(s.titulo)+'</b>'
      +'<div class="mini">'+esc(msgDdmm(s.quando))+' · tentativas '+msgNum(s.tent)+'</div>'
      +(s.chave?'<div class="mini mono" style="font-size:10px">'+esc(s.chave)+'</div>':'')+'</li>';
  });
  h+='</ul>';
  if(!passos.length)h+='<div class="empty"><span class="ico">🔎</span><b>Sem eventos para esta correlação</b><span class="mini">Nenhum evento de auditoria com este correlationId.</span></div>';
  if(body)body.innerHTML=h;
  const btn=$('msgDrRepro');
  if(btn){btn.disabled=!(item&&item.state!=='reprocessando');btn.setAttribute('data-msg-id',item?item.id:'');}
  if(drawer)drawer.classList.add('on');
}

/* ---------- ações ---------- */
function msgAcharItem(id){let r=null;MSG.itens.forEach(function(it){if(it.id===id)r=it;});return r;}
async function msgReprocessar(id){
  const it=msgAcharItem(id);
  if(!it||it.state==='reprocessando')return;
  it.state='reprocessando';
  msgRender();
  msgToast('Reprocessando <b>'+esc(it.tipo)+'</b>… a mensagem volta para a fila.','warn');
  try{
    const r=await (await fetch('/api/mensageria/dlq/reprocessar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})).json();
    if(r&&r.erro)msgToast('Falha ao reprocessar: '+esc(r.erro),'err');
    else msgToast('Reprocessado — a mensagem voltou para a fila <b>'+esc(it.tipo)+'</b>.');
  }catch(e){
    msgToast('Falha ao reprocessar: '+esc(String((e&&e.message)?e.message:e)),'err');
  }
  it.state=null;
  await carregarMensageria();
}
function msgDescartar(id){
  const it=msgAcharItem(id);
  if(!it)return;
  msgAbrirModal({
    titulo:'Descartar mensagem da DLQ?',perigo:true,ok:'Descartar mesmo assim',
    corpo:'Você vai <b>descartar</b> a mensagem <span class="mono">'+esc(it.id)+'</span> do tipo <b>'+esc(it.tipo)+'</b>.<br><br>Ela será <b>removida da DLQ</b> e <b>não volta para a fila</b>. Não há como desfazer esta ação.',
    aoConfirmar:async function(){
      try{
        const r=await (await fetch('/api/mensageria/dlq/descartar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})).json();
        if(r&&r.erro)msgToast('Falha ao descartar: '+esc(r.erro),'err');
        else msgToast('Descartada — a mensagem saiu da DLQ e não será reprocessada.','warn');
      }catch(e){
        msgToast('Falha ao descartar: '+esc(String((e&&e.message)?e.message:e)),'err');
      }
      await carregarMensageria();
    }
  });
}
function msgReprocessarTudo(){
  const lista=msgFiltrados();
  if(!lista.length){msgToast('Nada para reprocessar neste filtro.','warn');return;}
  const tipo=MSG.filtro;
  msgAbrirModal({
    titulo:'Reprocessar todas as mensagens da DLQ?',
    ok:'Reprocessar '+lista.length+' '+msgPlural(lista.length,'mensagem','mensagens'),
    corpo:'Você vai reprocessar <b>'+lista.length+'</b> '+msgPlural(lista.length,'mensagem','mensagens')+' '+(tipo==='todas'?'<b>de todas as filas</b>':'do tipo <b>'+esc(tipo)+'</b>')+'.<br><br>'+msgPlural(lista.length,'Ela volta','Elas voltam')+' para a fila de origem e seguem o ritmo normal (1 a cada <b>CLIENTES_INTERVALO_S</b>, dentro da janela comercial) — <b>não</b> vira rajada. Itens que já falharam de forma <b>não transitória</b> tendem a falhar de novo.',
    aoConfirmar:async function(){
      const body={ids:lista.map(function(i){return i.id;})};
      if(tipo&&tipo!=='todas')body.tipo=tipo;
      try{
        const r=await (await fetch('/api/mensageria/dlq/reprocessar-lote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
        if(r&&r.erro)msgToast('Falha no lote: '+esc(r.erro),'err');
        else msgToast('♻️ '+msgNum(r.total)+' '+msgPlural(r.total,'mensagem reprocessada','mensagens reprocessadas')+' — voltaram para a fila.');
      }catch(e){
        msgToast('Falha no lote: '+esc(String((e&&e.message)?e.message:e)),'err');
      }
      await carregarMensageria();
    }
  });
}

/* ---------- wiring ---------- */
document.addEventListener('click',function(ev){
  const t=ev.target&&ev.target.closest?ev.target.closest('[data-msg-act]'):null;
  if(!t)return;
  const act=t.getAttribute('data-msg-act');
  if(act==='copy')msgCopiar(t.getAttribute('data-msg-val'));
  else if(act==='repro')msgReprocessar(t.getAttribute('data-msg-id'));
  else if(act==='desc')msgDescartar(t.getAttribute('data-msg-id'));
  else if(act==='trail')msgAbrirTrilha(t.getAttribute('data-msg-corr'));
});
document.addEventListener('click',function(ev){
  const b=ev.target&&ev.target.closest?ev.target.closest('.tab[data-msg-f]'):null;
  if(!b)return;
  MSG.filtro=b.getAttribute('data-msg-f');
  msgRender();
});
document.addEventListener('keydown',function(ev){
  if(ev.key==='Escape'){
    const d=$('msgDrawer');if(d)d.classList.remove('on');
    msgFecharModal();
  }
});
document.addEventListener('DOMContentLoaded',function(){
  const filtro=$('msgDlqFiltro'),busca=$('msgDlqBusca'),btnAll=$('btnMsgReproAll');
  const btnRefresh=$('btnMsgRefresh');
  if(btnRefresh)btnRefresh.addEventListener('click',function(){MSG.erro=null;carregarMensageria();msgToast('Snapshot atualizado.');});
  if(filtro)filtro.addEventListener('change',function(){MSG.filtro=this.value;msgRender();});
  if(busca)busca.addEventListener('input',function(){MSG.busca=this.value;msgRender();});
  if(btnAll)btnAll.addEventListener('click',msgReprocessarTudo);
  const mc=$('msgModCancel'),mo=$('msgModOk'),mod=$('msgMod'),dc=$('msgDrClose'),dr=$('msgDrRepro');
  if(mc)mc.addEventListener('click',msgFecharModal);
  if(mo)mo.addEventListener('click',function(){const cb=msgModalCb;msgFecharModal();if(cb)cb();});
  if(mod)mod.addEventListener('click',function(ev){if(ev.target===this)msgFecharModal();});
  if(dc)dc.addEventListener('click',function(){const d=$('msgDrawer');if(d)d.classList.remove('on');});
  if(dr)dr.addEventListener('click',function(){const id=this.getAttribute('data-msg-id');if(id)msgReprocessar(id);});
  setInterval(function(){try{carregarMensageria();}catch(e){}},15000);
});

/* ---------- boot ---------- */
if (typeof navegar === 'function') navegar();
</script></body></html>`;

server.listen(PORT, HOST, () => {
  logger.info({ host: HOST, porta: PORT }, "manager iniciado");
  console.log(`gerenciador em http://${HOST}:${PORT} (LAN exige TLS/reverse proxy)`);
  if (process.env.ALCANCE_SMOKE === "1") {
    // Smoke test: não inicia workers (evita tocar em fila/estado real).
    console.log("smoke mode: workers de fila desativados");
    return;
  }
  iniciarFilaWorker();
  iniciarClientesWorker();
  iniciarSyncGruposDiario();
  // Mensageria: reentrega o que ficou na fila dos assinantes (eventos
  // publicados enquanto o processo estava fora).
  void processarPendentes().then((n) => {
    if (n) console.log(`mensageria: ${n} evento(s) reentregue(s) no boot`);
  });
  // Piloto: o store é lazy — sem isto, os timers nunca são agendados no boot
  // e o Piloto fica muda (mesmo com a grade "ligada" no painel).
  const rl = retomarLoopsNoBoot();
  if (rl.religados > 0) console.log(`piloto: ${rl.religados} loop(s) religados no boot`);
  else if (rl.pausados > 0) console.log(`piloto: ${rl.pausados} loop(s) pausados no boot — clique em START (PILOTO_AUTORELIGA=1 religa sozinho)`);
  console.log(`fila anti-rajada ativa: 1 envio a cada ${intervaloFila()}s`);
});

let encerrando = false;
async function encerrar(sinal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  logger.info({ sinal }, "shutdown iniciado");
  try { pararFilaWorker(); } catch { /* ignore */ }
  try { pararClientesWorker(); } catch { /* ignore */ }
  try { pararSyncGruposDiario(); } catch { /* ignore */ }
  await aguardarProcessamento(30_000);
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  logger.info({ sinal }, "shutdown concluído");
  process.exit(0);
}

process.on("SIGTERM", () => { void encerrar("SIGTERM"); });
process.on("SIGINT", () => { void encerrar("SIGINT"); });
process.on("unhandledRejection", (e) => {
  logger.error({ err: String((e as any)?.stack ?? e) }, "unhandledRejection");
});
process.on("uncaughtException", (e) => {
  logger.fatal({ err: String((e as any)?.stack ?? e) }, "uncaughtException");
  process.exit(1);
});
