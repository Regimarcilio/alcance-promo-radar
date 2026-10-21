import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { status as pilotoStatus, start as pilotoStart, stop as pilotoStop, ligarTudo, lerCesta, salvarCesta, limparCesta } from "../ml/piloto.js";
import { colher, lerMapaVitrine, definirMapaVitrine, folhasDescobertas } from "../ml/vitrine.js";
import { subcategoriasDe } from "../ml/hub.js";
import { gerarHeadline } from "../ai/gateway.js";
import { formatar } from "../wa/formatter.js";
import { registrarEnvio } from "../store/dedup.js";
import { enviarParaGrupo } from "../wa/dispatch.js";
import {
  carregarMonitor, adicionarRegra, removerDestino, removerRegra, definirAutoEnviar, definirFoto,
  alternarOrigem, alternarDestino,
} from "../monitor/grupos.js";
import { processar as processarMonitor, extrairMensagem } from "../monitor/webhook.js";
import { eventos as eventosMonitor, resumo as resumoMonitor, zerarContadores, limparDedup } from "../monitor/state.js";
import { tamanhoFila, intervaloFila, limparFila, iniciarFilaWorker } from "../monitor/fila.js";
import {
  listarContatos, listarListas, criarLista, removerLista, adicionarContato, renomearContato,
  removerContato, sincronizar as sincronizarClientes, estadoSync, enfileirarCampanha,
  estadoFilaClientes, limparFilaClientes, iniciarClientesWorker,
} from "../clientes/clientes.js";
import { lerTitulos, definirTitulo } from "../ui/titulos.js";
import { detectar as detectarOferta, rotulo as rotuloPrograma } from "../monitor/parser.js";
import { expandirLink } from "../monitor/curtos.js";
import {
  listarGrupos, estadoConexao, contaPareada, reiniciar, desconectar, configurarWebhook,
  adicionarParticipantes, buscarPermissaoGrupo, definirPermissaoGrupo, gruposDoCache,
  type AcaoGrupo,
} from "../monitor/evolution.js";
import {
  listarInstancias, estadoInstancia as estadoInstanciaWhats, adicionarInstancia, qrInstancia,
  definirAtivo as definirAtivoWhats, definirPeso, removerInstancia, MAX_INSTANCIAS,
} from "../wa/rotacao.js";
import {
  autenticar, auditar, checarLimite, configurarAuth, cookieExpirado, cookieSessao,
  criarSessao, encerrarSessao, HashOcupadoError, iguais, iniciarLimpezaAuth, ipDoRequest,
  limparLimite, registrarTentativa, sessaoDoRequest, validarConfigAuth, type Usuario,
} from "./auth.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ALCANCE_DATA_DIR permite smoke/teste em diretório temporário sem tocar no estado real.
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const cacheFile = join(dataDir, "ultima-busca.json");
const CATS = catsJson as { id: string; name: string }[];
const CATS_AMAZON = CATEGORIAS_AMAZON;
const PORT = Number(process.env.MANAGER_PORT ?? 8091);

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const metodo = req.method ?? "GET";
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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  );

  const caminho = url.pathname;
  const ip = ipDoRequest(req);
  const ua = String(req.headers["user-agent"] ?? "");
  const ehWebhook = caminho === "/api/webhook/evolution";

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
    limparLimite(ip);
    const sessao = criarSessao(usuario, ip, ua);
    auditar("login_ok", { usuario: usuario.usuario, ip, ua });
    json(200, {
      ok: true,
      usuario: { nome: usuario.usuario, papel: usuario.papel },
    }, { "Set-Cookie": cookieSessao(sessao.valor, sessao.maxAge) });
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
      json(500, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/contas") {
    try {
      json(200, { contas: listarContas(), mapa: lerMapa() });
    } catch (e: any) {
      json(500, { erro: String(e.message ?? e) });
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
    // fetchAllGroups é lento (~10s): cache de 60s para a UI abrir instantânea.
    try {
      const refresh = url.searchParams.get("refresh") === "1";
      if (cacheGrupos && !refresh && Date.now() - cacheGrupos.em < 60_000) {
        json(200, { grupos: cacheGrupos.dados, cache: true });
        return;
      }
      const base = (process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
      const inst = process.env.EVO_INSTANCE ?? "radar-piloto";
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      const r = await fetch(`${base}/group/fetchAllGroups/${inst}?getParticipants=false`, {
        headers: { apikey: process.env.EVO_KEY ?? "" },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (!r.ok) throw new Error(`Evolution ${r.status}`);
      const gs: any[] = await r.json();
      const dados = (Array.isArray(gs) ? gs : []).map((g: any) => ({
        id: g.id, nome: g.subject || g.name || g.id || "(sem nome)", tamanho: g.size ?? null,
      }));
      cacheGrupos = { em: Date.now(), dados };
      json(200, { grupos: dados });
    } catch (e: any) {
      // Fallback: última lista salva em disco (Evolution limitada/fora).
      const salvo = gruposDoCache();
      const lista = cacheGrupos?.dados ?? salvo.grupos;
      json(200, {
        grupos: lista,
        aviso: `Evolution inacessível: ${e.message}${lista.length ? " — mostrando a última lista salva" : ""}`,
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
      json(500, { erro: String(e.message ?? e) });
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
      json(500, { erro: String(e.message ?? e) });
    }
    return;
  }
  // ---------- E6 MONITOR ----------
  if (req.method === "GET" && url.pathname === "/api/instancias") {
    const itens = await Promise.all(
      listarInstancias().map(async (i) => ({ ...i, estado: await estadoInstanciaWhats(i.instancia) }))
    );
    json(200, { max: MAX_INSTANCIAS, itens });
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
      const r = await adicionarParticipantes(grupoJid, numeros);
      json(r.ok ? 200 : 502, {
        ok: r.ok,
        adicionados: r.adicionados,
        requested: numeros.length,
        erro: r.erro,
      });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/enviar") {
    try {
      const b = JSON.parse(await lerCorpo(req));
      const pendentes = enfileirarCampanha({
        texto: String(b.texto ?? ""),
        imagem: String(b.imagem ?? ""),
        jids: Array.isArray(b.jids) ? b.jids.map(String) : [],
      });
      json(200, { ok: true, fila: estadoFilaClientes(), pendentes });
    } catch (e: any) {
      json(400, { erro: String(e.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/clientes/fila/limpar") {
    json(200, { ok: true, removidos: limparFilaClientes(), fila: estadoFilaClientes() });
    return;
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
    json(200, {
      ...resumoMonitor(), autoEnviar: s.autoEnviar, origens: s.regras.length, destinos,
      fila: tamanhoFila(), intervaloFila: intervaloFila(),
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
  if (req.method === "GET" && url.pathname === "/api/monitor/conta") {
    const [estado, conta] = await Promise.all([estadoConexao(), contaPareada()]);
    json(200, { estado, ...conta, instancia: process.env.EVO_INSTANCE ?? "radar-piloto" });
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
      const r = await fetch(`${(process.env.EVO_URL ?? "").replace(/\/$/, "")}/instance/connect/${process.env.EVO_INSTANCE ?? "radar-piloto"}`, {
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
      const p = JSON.parse(await lerCorpo(req));
      if (process.env.MONITOR_DEBUG === "1") {
        try {
          const { appendFileSync } = await import("node:fs");
          const d: any = (p as any)?.data ?? {};
          const m: any = d?.message ?? {};
          const img = m.imageMessage;
          const resumo = {
            ev: (p as any)?.event, jid: d?.key?.remoteJid, fromMe: d?.key?.fromMe,
            tipos: Object.keys(m),
            img: img ? {
              mimetype: img.mimetype, fileLength: img.fileLength,
              temUrl: !!img.url, temThumb: !!img.jpegThumbnail,
              caption: String(img.caption ?? "").slice(0, 40),
            } : null,
            base64: m.base64 === undefined ? "ausente" : typeof m.base64 === "string" ? `string(${m.base64.length})` : typeof m.base64,
            mediaUrl: m.mediaUrl ? String(m.mediaUrl).slice(0, 60) : null,
          };
          appendFileSync("/app/data/debug-webhook.log", new Date().toISOString() + " " + JSON.stringify(resumo) + "\n");
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
});

function lerCorpo(req: any, max = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = "";
    let n = 0;
    let excedeu = false;
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
}</style></head>
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
<div class="hint">Aperte <b>LIGA TUDO</b> e esqueça: liga 1 loop por categoria amarrada (conta+grupo do mapa, até 5). Ou monte 1 loop manual abaixo.</div>
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
<div class="panel ac-monitor">
<div class="panel-head"><span><b id="tit-monitor">📡 Monitor</b> — cada grupo de origem encaminha para os SEUS destinos</span><a class="lk-mini" href="#" onclick="renomearCard('monitor');return false">✏️ renomear</a></div>
<div class="hint">Oferta publicada numa <b>origem</b> (grupo de achadinhos que você monitora) tem o link trocado pelo <b>seu</b> e é reenviada <b>apenas</b> para os destinos amarrados àquela origem. Uma origem pode ter vários destinos.</div>

<div class="mrow">
<div><b id="mcontalabel">Conta WhatsApp: …</b><br><span class="mini" id="mcontaestado"></span></div>
<div style="display:flex;gap:8px"><button class="mbtn" onclick="reiniciarEvo()">↻ Reconectar</button><button class="mbtn" onclick="trocarCelular()">📱 Trocar celular</button></div></div>

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
<div class="mini" style="margin-bottom:6px">Sorteio ponderado entre os números <b>ativos e conectados</b>. Número caído é pulado. A conta ML continua a mesma.</div>
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
  <span class="mini" id="cliaddmsg"></span>
</div>
<div id="clilist" style="max-height:240px;overflow:auto;border:1px solid var(--border-strong);border-radius:10px;padding:4px;margin-top:8px"></div>
<div id="clilistas" style="margin-top:10px;font-size:13px"></div>
<div class="mbox" style="margin-top:10px">
<label>✉️ Propaganda para a seleção</label>
<textarea id="clitexto" rows="3" style="width:100%;" placeholder="Texto da propaganda (pode colar o link no meio)…"></textarea>
<input id="cliimagem" placeholder="URL da imagem (opcional)" style="width:100%;margin-top:6px;">
<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
<button class="buscar" style="margin-top:0;width:auto" onclick="dispararClientes()">🚀 Disparar</button>
<button class="mbtn" onclick="limparFilaClientesUI()">🗑 Cancelar fila</button>
<span class="mini" id="clifila"></span></div></div>
</div>
</section>
</main>
</div>
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
  rastreio:{k:'operação',t:'Rastreio',s:'Tudo que o Alcance publicou (Piloto + Monitor) com o link de afiliado — para cruzar com o painel de comissão.'}
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
  $('mapcat').innerHTML=cs.map(c=>\`<option value="\${c.id}">\${c.name}</option>\`).join('');
  $('pacat').innerHTML=cs.map(c=>\`<option value="\${c.id}">\${c.name}</option>\`).join('');
  carregarContas();
  carregarGrupos();
  carregarVitrine();
  carregarCupons();
  carregarMonitorUI();
  carregarTitulos();
  atualizarPiloto();
  carregarClientes();
  setInterval(function(){try{carregarMonitorStatus();}catch(e){}},15000);
  setInterval(function(){try{carregarClientes();}catch(e){}},15000);
});
let CS=[];
async function carregarVitrine(){
  const d=await (await fetch('/api/vitrine')).json();
  CS=d.items||[];
  if(!d.ok){$('vitrineout').innerHTML='⚠️ '+(d.erro||'vitrine indisponível');return;}
  const cats=await (await fetch('/api/categorias')).json();
  const opts=cats.map(function(c){return '<option value="'+c.id+'">'+c.name+'</option>';}).join('');
  let html='<b>'+d.total+'</b> ofertas reais. Amarre a folha à sua categoria:<br>';
  (d.folhas||[]).forEach(function(f,i){
    html+='<div style="display:flex;gap:8px;margin-top:6px;align-items:center"><span style="flex:2">'+f.leaf+' ('+f.qtd+' itens — '+f.exemplo.slice(0,40)+'…)</span>'
      +'<select id="vmap'+i+'" style="flex:2">'+opts+'</select>'
      +'<button class="buscar" style="margin-top:0;width:auto" data-leaf="'+f.leaf+'" data-i="'+i+'" onclick="salvarVitrineMapBtn(this)">✔</button></div>';
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
  const opts=d.contas.map(c=>\`<option value="\${c.nome}">\${c.nome} (\${c.tagMask})\${c.padrao?' ★':''}</option>\`).join('');
  $('paconta').innerHTML=opts;
  $('mapconta').innerHTML='<option value="-">Padrão</option>'+opts;
  $('contasout').innerHTML=d.contas.map(c=>\`\${c.padrao?'★':'•'} <b>\${c.nome}</b> <small>\${c.tagMask}</small> <a href="#" class="lk-mini" onclick="tornarPadrao('\${c.nome}');return false">tornar padrão</a>\`).join('<br>')||'Nenhuma conta — usando .env.';
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
    let opts=(g.grupos||[]).map(function(x){return '<option value="'+x.id+'">'+x.nome+' ('+x.id.slice(0,12)+'…)</option>';}).join('');
    $('mapgrupo').innerHTML='<option value="">Grupo padrão (.env)</option>'+opts;
    $('pagrupo').innerHTML='<option value="">— escolha o grupo —</option>'+opts;
    if(g.aviso)$('pagrupo').innerHTML+='<option value="" disabled>⚠️ '+g.aviso+'</option>';
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
    kp('kpi-loops',n+'/5');kp('kpi-piloto-env',env);kp('kpi-piloto-ult',ult?horaLocal(ult):'—');kp('badge-piloto',n);
    let html=n? '' : '⚪ nenhum loop — monte acima e aperte START.';
    (s.loops||[]).forEach(function(l){
      html+='<div style="border:1px solid var(--border-strong);border-radius:10px;padding:8px;margin:6px 0;font-size:12.5px">'
        +'<b>#'+l.id+'</b> '+l.conta+' → '+l.category+' → '+String(l.grupo).slice(0,20)+'… '
        +'• enviadas: <b>'+l.enviadas+'</b>'
        +(l.ultimaMsg?' • última: '+horaLocal(l.ultimaMsg):'')
        +(l.proximaEm?' • próxima: '+horaLocal(l.proximaEm):'')
        +' <button class="ghost" style="width:auto;padding:4px 10px;margin:0" onclick="pilotoStop('+l.id+')">⏹</button></div>';
    });
    html+='<div style="margin-top:6px"><b>'+n+'/5 loops</b> <button class="ghost" style="width:auto;padding:4px 10px" onclick="pilotoStopAll()">⏹ parar todos</button></div>';
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
    html+=regs.length?regs.map(function(e){const v=(typeof e[1]==='string')?{codigo:e[1],nome:''}:e[1];return e[0]+'=<b>'+v.codigo+'</b>'+(v.nome?' ('+v.nome+')':'');}).join(' · '):'nenhum';
    html+='<br><b>ML p/ esta categoria:</b> ';
    html+=(d.paraCategoria||[]).map(function(c){return c.titulo+(c.minimo?' ('+c.minimo+')':'');}).join(' · ')||'—';
    if(d.codigo)html+='<br>Ativo aqui: <b>'+d.codigo+'</b>';
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
    if(!itens.length){$('minstlist').textContent='nenhum número — adicione um.';return;}
    $('minstlist').innerHTML=itens.map(function(i){
      const ic=i.estado==='open'?'🟢':i.estado==='connecting'?'🟡':'🔴';
      let acoes='';
      if(i.estado!=='open') acoes+='<button class="mbtn" onclick="verQR(\\''+i.instancia+'\\')">QR</button>';
      acoes+='<button class="mbtn" onclick="instAtivo(\\''+i.instancia+'\\','+(i.ativo?'false':'true')+')">'+(i.ativo?'desativar':'ativar')+'</button>';
      acoes+='<button class="mbtn" onclick="instPeso(\\''+i.instancia+'\\','+i.peso+')">peso</button>';
      acoes+='<button class="mbtn" onclick="instRemover(\\''+i.instancia+'\\')">🗑</button>';
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border)">'+
        '<span>'+esc(i.nome)+' <span class="mini">'+ic+' '+esc(i.estado)+' · peso '+i.peso+' · '+i.enviadas+' env'+(i.ativo?'':' · OFF')+'</span></span>'+
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
    $('clifila').textContent='fila: '+(f.pendentes||0)+' pendente(s) · enviados: '+(f.enviados||0)+(f.erros?(' · erros: '+f.erros):'')+' · 1 a cada '+(f.intervalo||60)+'s';
    kp('kpi-clifila',f.pendentes||0);
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
    renderContatos(); renderListas();
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
      +'<input type="checkbox" data-sel="'+c.jid+'"'+(SELECAO.has(c.jid)?' checked':'')+'>'
      +'<span style="flex:1;font-size:13px">'+esc(nome)+(c.nome?(' <span class="mini">'+esc(telFmt(c.telefone))+'</span>'):'')
      +(c.origem?('<br><span class="mini">'+esc(String(c.origem).slice(0,42))+'</span>'):'')+'</span>'
      +'<button class="mbtn" data-act="ren" data-jid="'+c.jid+'">✏️</button>'
      +'<button class="mbtn" data-act="del" data-jid="'+c.jid+'">🗑</button></div>';
  }).join('');
}
function renderListas(){
  const ls=CLIENTES.listas||[];
  if(!ls.length){$('clilistas').innerHTML='<span class="mini">nenhuma lista salva</span>';return;}
  $('clilistas').innerHTML='<label>📋 Listas salvas</label>'+ls.map(function(l){
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">'
      +'<span style="flex:1">'+esc(l.nome)+' <span class="mini">'+l.contatos.length+' contato(s)</span></span>'
      +'<button class="mbtn" data-act="sell" data-jid="'+l.id+'">selecionar</button>'
      +'<button class="mbtn" data-act="dell" data-jid="'+l.id+'">🗑</button></div>';
  }).join('');
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
    $('rtinfo').textContent=ps.length+' publicação(ões) listada(s)';
    if(!ps.length){$('rtlista').innerHTML='<div class="mini">Nada publicado ainda neste filtro.</div>';return;}
    $('rtlista').innerHTML='<div style="display:flex;flex-direction:column;gap:4px">'+ps.map(function(p){
      return '<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">'
        +'<span class="mini" style="white-space:nowrap">'+esc(new Date(p.em).toLocaleString('pt-BR'))+'</span>'
        +'<span class="mini" style="min-width:58px">'+esc(p.programa)+'</span>'
        +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.titulo||p.id)+'</span>'
        +'<span class="mini">'+esc(p.categoria)+'</span>'
        +(p.tag?('<span class="mini">tag: '+esc(p.tag)+'</span>'):'')
        +'<a class="lk-mini" href="'+esc(p.link)+'" target="_blank" rel="noopener">abrir</a></div>';
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
  selCat.innerHTML=resp.map(function(c){return '<option value="'+c.id+'">'+c.name+' ('+c.id+')</option>';}).join('');
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
  if(!confirm('Adicionar '+SELECAO.size+' contato(s) em "'+nomeGrupo+'"?\\n\\nSó funciona se esta conta for ADMIN do grupo e o grupo tiver link de convite ativo.'))return;
  $('cliaddmsg').textContent='adicionando…';
  const r=await (await fetch('/api/clientes/grupo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grupoJid:grupo,jids:[...SELECAO]})})).json();
  if(r.erro){$('cliaddmsg').textContent='erro: '+r.erro;return alert('Erro: '+r.erro);}
  $('cliaddmsg').textContent=(r.adicionados||0)+' adicionado(s) ✓';
  SELECAO.clear();
  renderContatos();
  atualizarCaixaAdicionar();
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
    $('mcontaestado').innerHTML=(ok?'🟢 conectada':'🔴 '+(d.estado||'?'))+' • instância '+d.instancia;
  }catch(e){}
}
async function carregarGruposSelects(forcar){
  $('mgruposinfo').textContent='buscando grupos… (a Evolution leva 10-30s; se o WhatsApp limitar, mostramos a última lista salva)';
  try{
    const d=await (await fetch('/api/monitor/whats-grupos'+(forcar?'?forcar=1':''))).json();
    const aviso=d.aviso?(' · '+d.aviso):'';
    if(!d.ok&&!(d.grupos||[]).length){$('mgruposinfo').innerHTML='<span style="color:var(--danger-tx)">'+(d.erro||'erro')+aviso+'</span>';return;}
    window.__wgrupos=d.grupos||[];
    const opts=window.__wgrupos.map(function(g){return '<option value="'+esc(g.jid)+'">'+esc(g.nome)+(g.tamanho!=null?' ('+g.tamanho+')':'')+'</option>';}).join('');
    $('mselOrigem').innerHTML='<option value="">— escolha a origem —</option>'+opts;
    $('mselDestino').innerHTML='<option value="">— escolha o destino —</option>'+opts;
    $('mselPermissao').innerHTML='<option value="">— escolha o grupo —</option>'+opts;
    $('mgruposinfo').textContent=window.__wgrupos.length+' grupos carregados'+(d.deCache?' (lista salva — Evolution limitada)':'')+aviso;
  }catch(e){$('mgruposinfo').innerHTML='<span style="color:var(--danger-tx)">erro: '+e.message+'</span>';}
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
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
</script></body></html>`;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`gerenciador em http://localhost:${PORT} (porta publicada só em 127.0.0.1; LAN exige TLS)`);
  if (process.env.ALCANCE_SMOKE === "1") {
    // Smoke test: não inicia workers (evita tocar em fila/estado real).
    console.log("smoke mode: workers de fila desativados");
    return;
  }
  iniciarFilaWorker();
  iniciarClientesWorker();
  console.log(`fila anti-rajada ativa: 1 envio a cada ${intervaloFila()}s`);
});
