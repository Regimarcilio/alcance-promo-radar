import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import catsJson from "../categorias.json" with { type: "json" };
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
import {
  listarGrupos, estadoConexao, contaPareada, reiniciar, desconectar, configurarWebhook,
} from "../monitor/evolution.js";
import {
  listarInstancias, estadoInstancia as estadoInstanciaWhats, adicionarInstancia, qrInstancia,
  definirAtivo as definirAtivoWhats, definirPeso, removerInstancia, MAX_INSTANCIAS,
} from "../wa/rotacao.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const cacheFile = join(dataDir, "ultima-busca.json");
const CATS = catsJson as { id: string; name: string }[];
const PORT = Number(process.env.MANAGER_PORT ?? 8091);

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
  const json = (code: number, obj: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  // Trava opcional: se MANAGER_KEY definida no .env, POSTs exigem o header.
  // GETs (leitura) seguem abertos na rede local.
  // Exceção: /api/webhook/evolution usa WEBHOOK_KEY (validado na própria rota),
  // pois o Evolution não envia X-Manager-Key.
  const MKEY = process.env.MANAGER_KEY?.trim() || "";
  const ehWebhook = url.pathname === "/api/webhook/evolution";
  if (req.method === "POST" && MKEY && !ehWebhook && req.headers["x-manager-key"] !== MKEY) {
    json(401, { erro: "MANAGER_KEY inválida." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGINA);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/categorias") {
    json(200, CATS);
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
        { conta: b.conta ?? "", category: b.category ?? "", grupo: b.grupo ?? "", sub: b.sub ?? "", qtd: b.qtd ?? 2, intervaloS: b.intervaloS ?? 60, filtro: String(b.filtro ?? "").trim(), minMin: 5, maxMin: 5 },
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
        id: g.id, nome: g.subject ?? g.name ?? g.id, tamanho: g.size ?? null,
      }));
      cacheGrupos = { em: Date.now(), dados };
      json(200, { grupos: dados });
    } catch (e: any) {
      json(200, { grupos: cacheGrupos?.dados ?? [], aviso: `Evolution inacessível: ${e.message}` });
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
      json(200, { ok: false, erro: String(e?.message ?? e), grupos: [] });
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
    if (wkey && req.headers["x-webhook-key"] !== wkey) {
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

function lerCorpo(req: any): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c: any) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const PAGINA = `<!DOCTYPE html><html lang="pt-BR" data-paleta="verde"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gerenciador — autoMensagemWhats</title>
<style>:root{
  color-scheme:light;
  --bg:#f5f7f9; --surface:#ffffff; --surface-2:#f2f5f8;
  --text:#15212a; --muted:#566470; --faint:#7b8894;
  --border:#e4e9ee; --border-strong:#cfd8e0;
  --mut:var(--muted);
  --radius:10px; --radius-box:12px; --radius-card:16px;
  --shadow-sm:0 1px 2px rgba(15,23,42,.05),0 2px 8px rgba(15,23,42,.04);
  --shadow-md:0 6px 20px rgba(15,23,42,.10);
  --code-bg:#f6f8fa; --code-tx:#243445;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --ok-soft:#e7f6ef; --ok-bd:#a9dcc6; --ok-tx:#0b5c43;
  --warn-soft:#fdf6e2; --warn-bd:#ecd28c; --warn-tx:#7a5410;
  --danger-soft:#fdecec; --danger-bd:#f2b8b8; --danger-tx:#8f1d1d;
  --info:#2563eb;
  --price:#047857;
  --ac-piloto:#0e9f6e; --ac-monitor:#2563eb; --ac-clientes:#d97706;
  --primary:#047857; --primary-hover:#03624a; --primary-soft:#e7f6f0;
  --primary-border:#b6dfd0; --primary-contrast:#ffffff; --ring:rgba(4,120,87,.30);
}
[data-paleta="azul"]{
  --primary:#2563eb; --primary-hover:#1d4ed8; --primary-soft:#e9f0fe;
  --primary-border:#bcd1fa; --primary-contrast:#ffffff; --ring:rgba(37,99,235,.28);
}
[data-paleta="laranja"]{
  --primary:#c2410c; --primary-hover:#9a3412; --primary-soft:#fdeee5;
  --primary-border:#f4c7a9; --primary-contrast:#ffffff; --ring:rgba(194,65,12,.28);
}
[data-paleta="vermelho"]{
  --primary:#d02626; --primary-hover:#b91c1c; --primary-soft:#fdeaea;
  --primary-border:#f4bcbc; --primary-contrast:#ffffff; --ring:rgba(208,38,38,.26);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scrollbar-color:var(--border-strong) transparent}
body{
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;
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
.paleta-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.paleta-bar .rotulo{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.swatch{width:26px;height:26px;border-radius:999px;padding:0;cursor:pointer;border:2px solid var(--surface);box-shadow:0 0 0 1px var(--border-strong);background:var(--sw,#c8d0d8);transition:transform .15s ease,box-shadow .15s ease}
.swatch:hover{transform:scale(1.1)}
.swatch:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.swatch[aria-pressed="true"]{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--sw)}
.swatch[aria-pressed="true"]::after{content:"✓";display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#fff;font-size:13px;font-weight:800}
.swatch[data-p="verde"]{--sw:#10b981}
.swatch[data-p="azul"]{--sw:#3b82f6}
.swatch[data-p="laranja"]{--sw:#f97316}
.swatch[data-p="vermelho"]{--sw:#ef4444}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-card);padding:18px;margin-bottom:16px;box-shadow:var(--shadow-sm)}
.panel.ac-piloto{border-top:3px solid var(--ac-piloto)}
.panel.ac-monitor{border-top:3px solid var(--ac-monitor)}
.panel.ac-clientes{border-top:3px solid var(--ac-clientes)}
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
.buscar,.enviar{background:var(--primary);color:var(--primary-contrast);width:100%;margin-top:12px;font-size:15px;font-weight:800}
.buscar:hover,.enviar:hover{background:var(--primary-hover)}
.enviar{margin-top:10px}
.ghost{background:var(--surface);color:var(--text);border-color:var(--border-strong);width:100%;margin-top:12px;font-size:15px}
.ghost:hover{background:var(--surface-2);border-color:#bfc9d2}
.mbtn{background:var(--surface);color:var(--text);border-color:var(--border-strong);width:auto;margin:0;padding:7px 12px;font-size:12.5px;font-weight:600;border-radius:var(--radius);white-space:nowrap}
.mbtn:hover{background:var(--surface-2);border-color:#bfc9d2}
.mbtn.ok{background:var(--primary);border-color:var(--primary);color:var(--primary-contrast)}
.mbtn.ok:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.tgl{background:var(--surface-2);color:var(--muted);border:1px solid var(--border-strong);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:800;letter-spacing:.02em}
.tgl:hover{color:var(--text);border-color:#bfc9d2}
.tgl.on{background:var(--primary);border-color:var(--primary);color:var(--primary-contrast)}
.tgl.on:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
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
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-card);overflow:hidden;box-shadow:var(--shadow-sm);transition:box-shadow .18s ease,transform .18s ease}
.card:hover{box-shadow:var(--shadow-md);transform:translateY(-2px)}
.card img{width:100%;height:170px;object-fit:cover;background:var(--surface-2);display:block}
.noimg{height:110px;display:flex;align-items:center;justify-content:center;font-size:38px;color:var(--faint);background:linear-gradient(180deg,#f3f6f8,#e9eef2)}
.info{padding:14px;font-size:13px;line-height:1.5}
.info b.t{font-size:14px;display:block;margin-bottom:2px}
.preco{margin:8px 0}
.de{color:var(--muted);text-decoration:line-through}
.por{color:var(--price);font-weight:800;font-size:16px}
.meta{color:var(--muted);font-size:12px;margin:4px 0}
.link{color:var(--primary);font-weight:600;font-size:12px;word-break:break-all;overflow-wrap:anywhere}
.link:hover{text-decoration:underline}
.result{background:var(--primary-soft);border:1px solid var(--primary-border);border-radius:var(--radius-box);padding:14px;margin-top:14px;font-size:13px;display:none}
.result code{background:var(--code-bg);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--code-tx);font-family:var(--mono)}
code{font-family:var(--mono)}
.hint{font-size:12px;color:var(--muted);margin:6px 0 10px;line-height:1.55}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius-box);padding:12px;font-size:11.5px;font-family:var(--mono);line-height:1.55;color:var(--code-tx);white-space:pre-wrap;word-break:break-word;margin-top:10px;max-height:220px;overflow:auto;scrollbar-color:var(--border-strong) transparent}
.mrow{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-box);padding:12px;margin-top:10px}
.mbox{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-box);padding:14px;margin-top:10px}
.mini{font-size:12px;color:var(--muted);line-height:1.45}
.mini code{background:var(--code-bg);border:1px solid var(--border);padding:1px 6px;border-radius:6px;color:var(--code-tx);font-family:var(--mono);font-size:11px}
.regra{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--info);border-radius:var(--radius-box);padding:10px 12px;margin-top:8px}
.regra .orig{font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.regra .dest{font-size:13px;margin:8px 0 0 14px;padding:6px 0 0 10px;border-left:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.ctrls{display:flex;gap:6px;align-items:center;flex-shrink:0}
.regra.off{opacity:.55;background:var(--surface-2)}
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
  .swatch:hover{transform:none}
}</style></head>
<body>
<script>try{var p=localStorage.getItem('paleta');if(p){document.documentElement.setAttribute('data-paleta',p);}}catch(e){}</script>
<div class="paleta-bar" role="group" aria-label="Cor do tema da pagina">
<span class="rotulo">Cor do tema</span>
<button type="button" class="swatch" data-p="verde" aria-label="Usar tema verde" aria-pressed="true" title="Tema verde"></button>
<button type="button" class="swatch" data-p="azul" aria-label="Usar tema azul" aria-pressed="false" title="Tema azul"></button>
<button type="button" class="swatch" data-p="laranja" aria-label="Usar tema laranja" aria-pressed="false" title="Tema laranja"></button>
<button type="button" class="swatch" data-p="vermelho" aria-label="Usar tema vermelho" aria-pressed="false" title="Tema vermelho"></button>
</div>
<h1>🤖 Gerenciador <span>autoMensagemWhats</span></h1>
<div class="sub">Escolha <b>etiqueta → categoria → grupo</b>, aperte <b>LIGA TUDO</b> e receba <b>2 ofertas a cada 5 min</b> por categoria no WhatsApp (com pausa de 8 min a cada 55 min).</div>
<div class="panel">
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
<div style="margin-top:10px"><label>🎟️ Cupons (códigos digitáveis, estilo Emipe — criados no portal)</label>
<div class="hint">Cadastre 1 vez (ex.: chave <b>MLB1000</b>, código <b>PRIMEHOJE</b>) → anexado sozinho nas mensagens. Cupons do ML (clique-aplicar) vêm sozinhos por categoria.</div>
<div id="cuponsout" style="font-size:13px"></div>
<div style="display:flex;gap:8px;margin-top:6px"><input id="cpchave" style="flex:1" placeholder="chave: MLB1000 ou MLB1000:principal"><input id="cpcode" style="flex:1" placeholder="código: PRIMEHOJE"><input id="cpnome" style="flex:1" placeholder="nome: 10% OFF Voltagem"><button class="buscar" style="margin-top:0;width:auto" onclick="salvarCupomUI()">💾</button></div>
<div id="cuponsml" style="font-size:12px;margin-top:6px;color:var(--mut)"></div></div>
</div>
<div class="panel ac-piloto">
<div class="panel-head"><span><b id="tit-piloto">🚀 Piloto automático</b> — 2 ofertas aleatórias a cada 5 min, sozinho</span><a class="lk-mini" href="#" onclick="renomearCard('piloto');return false">✏️ renomear</a></div>
<div class="hint">Aperte <b>LIGA TUDO</b> e esqueça: liga 1 loop por categoria amarrada (conta+grupo do mapa, até 5). Ou monte 1 loop manual abaixo.</div>
<div style="display:flex;gap:8px;margin-bottom:10px"><button class="buscar" style="margin-top:0;flex:1;font-size:16px" onclick="ligaTudo()">▶ LIGA TUDO (automático)</button><button class="ghost" style="margin-top:0;flex:1" onclick="pilotoStop()">⏹ DESLIGA TUDO</button></div>
<div class="grid4">
<div><label>Etiqueta rastreada</label><select id="paconta"></select></div>
<div><label>Categoria</label><select id="pacat"></select></div>
<div><label>Subcategoria (filtro)</label><select id="pasub"><option value="">Categoria inteira</option></select></div>
<div><label>Grupo de destino</label><select id="pagrupo"></select></div></div>
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
<div class="panel ac-monitor">
<div class="panel-head"><span><b id="tit-monitor">📡 Monitor</b> — cada grupo de origem encaminha para os SEUS destinos</span><a class="lk-mini" href="#" onclick="renomearCard('monitor');return false">✏️ renomear</a></div>
<div class="hint">Oferta publicada numa <b>origem</b> (grupo de achadinhos que você monitora) tem o link trocado pelo <b>seu</b> e é reenviada <b>apenas</b> para os destinos amarrados àquela origem. Uma origem pode ter vários destinos.</div>

<div class="mrow">
<div><b id="mcontalabel">Conta WhatsApp: …</b><br><span class="mini" id="mcontaestado"></span></div>
<div style="display:flex;gap:8px"><button class="mbtn" onclick="reiniciarEvo()">↻ Reconectar</button><button class="mbtn" onclick="trocarCelular()">📱 Trocar celular</button></div></div>

<div class="mbox">
<div class="panel-head"><span><b id="tit-numeros">📱 Números</b> para envio rotativo <span class="mini" id="minstmax"></span></span><a class="lk-mini" href="#" onclick="renomearCard('numeros');return false">✏️ renomear</a></div>
<div class="mini" style="margin-bottom:6px">Sorteio ponderado entre os números <b>ativos e conectados</b>. Número caído é pulado. A conta ML continua a mesma.</div>
<div id="minstlist" class="mini">carregando…</div>
<div style="display:flex;gap:6px;margin-top:8px">
<input id="minstnome" placeholder="nome do celular (ex.: Celular 2)" maxlength="24" style="flex:1;">
<button class="mbtn" onclick="addInstancia()">➕ Adicionar celular</button></div>
<div id="minstqr" style="margin-top:10px"></div></div>

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
<div style="display:flex;gap:6px;margin-top:8px;align-items:center">
<input id="clibusca" placeholder="buscar por nome ou telefone" oninput="renderContatos()" style="flex:1;">
<span class="mini" id="clicount" style="white-space:nowrap"></span></div>
<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
<button class="mbtn" onclick="marcarTodos(true)">☑ Todos</button>
<button class="mbtn" onclick="marcarTodos(false)">☐ Limpar</button>
<button class="mbtn ok" onclick="salvarLista()">💾 Salvar selecionados como lista</button></div>
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
<script>
const $=id=>document.getElementById(id);
// Chave do gerenciador: se o servidor exigir (MANAGER_KEY), pede 1 vez e reusa.
(function(){
  const ofetch=window.fetch.bind(window);
  window.fetch=async function(u,opt){
    opt=opt||{};
    if(String(opt.method||'GET').toUpperCase()!=='GET'){
      opt.headers=Object.assign({},opt.headers,{'x-manager-key':sessionStorage.getItem('mkey')||''});
      let r=await ofetch(u,opt);
      if(r.status===401){
        const k=prompt('Chave do gerenciador (MANAGER_KEY do .env):');
        if(k===null||k==='')return r;
        sessionStorage.setItem('mkey',k);
        opt.headers=Object.assign({},opt.headers,{'x-manager-key':k});
        r=await ofetch(u,opt);
      }
      return r;
    }
    return ofetch(u,opt);
  };
})();
fetch('/api/categorias').then(r=>r.json()).then(cs=>{
  $('mapcat').innerHTML=cs.map(c=>\`<option value="\${c.id}">\${c.name}</option>\`).join('');
  $('pacat').innerHTML=cs.map(c=>\`<option value="\${c.id}">\${c.name}</option>\`).join('');
  carregarContas();
  carregarGrupos();
  carregarVitrine();
  carregarCupons();
  carregarMonitorUI();
  carregarTitulos();
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
  const r=await (await fetch('/api/piloto/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conta:$('paconta').value,category:$('pacat').value,grupo:$('pagrupo').value,sub:$('pasub').value,qtd:Number($('paqtd').value),intervaloS:Number($('pagap').value),filtro:($('pafiltro')?$('pafiltro').value:'')})})).json();
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
  var sws=document.querySelectorAll('.swatch');
  var validas={verde:1,azul:1,laranja:1,vermelho:1};
  function aplicar(p){
    if(!validas[p])p='verde';
    raiz.setAttribute('data-paleta',p);
    for(var i=0;i<sws.length;i++){
      var b=sws[i];
      b.setAttribute('aria-pressed', b.getAttribute('data-p')===p ? 'true' : 'false');
    }
    try{localStorage.setItem('paleta',p);}catch(e){}
  }
  var salva='verde';
  try{salva=localStorage.getItem('paleta')||'verde';}catch(e){}
  aplicar(salva);
  for(var j=0;j<sws.length;j++){
    sws[j].addEventListener('click',function(){aplicar(this.getAttribute('data-p'));});
  }
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
    const s=d.sync||{};
    $('clisync').textContent = s.rodando
      ? ('puxando… '+(s.feitos||0)+'/'+(s.total||0)+' grupos · '+(s.contatos||0)+' contatos')
      : (s.ultimoSync ? ('último sync: '+new Date(s.ultimoSync).toLocaleString('pt-BR')+' · '+(s.contatos||0)+' contatos') : 'nunca sincronizado');
    const f=d.fila||{};
    $('clifila').textContent='fila: '+(f.pendentes||0)+' pendente(s) · enviados: '+(f.enviados||0)+(f.erros?(' · erros: '+f.erros):'')+' · 1 a cada '+(f.intervalo||60)+'s';
    renderContatos(); renderListas();
  }catch(e){}
}
function filtroContatos(){
  const q=($('clibusca').value||'').toLowerCase().trim();
  return (CLIENTES.contatos||[]).filter(function(c){
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
async function syncClientes(){
  $('clisync').textContent='iniciando…';
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
$('clilist').addEventListener('change',function(ev){
  const el=ev.target;
  if(el && el.getAttribute && el.getAttribute('data-sel')){
    const jid=el.getAttribute('data-sel');
    if(el.checked)SELECAO.add(jid); else SELECAO.delete(jid);
    $('clicount').textContent=SELECAO.size+' sel.';
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
  $('mgruposinfo').textContent='buscando grupos…';
  try{
    const d=await (await fetch('/api/monitor/whats-grupos'+(forcar?'?forcar=1':''))).json();
    if(!d.ok){$('mgruposinfo').innerHTML='<span style="color:var(--danger-tx)">'+(d.erro||'erro')+'</span>';return;}
    window.__wgrupos=d.grupos||[];
    const opts=window.__wgrupos.map(function(g){return '<option value="'+esc(g.jid)+'">'+esc(g.nome)+(g.tamanho!=null?' ('+g.tamanho+')':'')+'</option>';}).join('');
    $('mselOrigem').innerHTML='<option value="">— escolha a origem —</option>'+opts;
    $('mselDestino').innerHTML='<option value="">— escolha o destino —</option>'+opts;
    $('mgruposinfo').textContent=window.__wgrupos.length+' grupos carregados';
  }catch(e){$('mgruposinfo').innerHTML='<span style="color:var(--danger-tx)">erro: '+e.message+'</span>';}
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
    $('mstatus').innerHTML='🔗 origens: <b>'+(d.origens||0)+'</b> · destinos: <b>'+(d.destinos||0)+'</b> · 📥 recebidas: <b>'+(d.recebidas||0)+'</b> · 🔄 encaminhadas: <b>'+(d.encaminhadas||0)+'</b> · ♻️ duplicadas: <b>'+(d.duplicadas||0)+'</b> · ✋ revisão: <b>'+(d.revisao||0)+'</b> · ⚠️ erros: <b>'+(d.erros||0)+'</b>';
    $('mfila').innerHTML='🚦 fila anti-rajada: <b>'+(d.fila||0)+'</b> em espera · liberando 1 a cada <b>'+(d.intervaloFila||120)+'s</b>'+(d.fila>0?' <span class="mini">(≈ '+Math.ceil((d.fila*(d.intervaloFila||120))/60)+' min p/ esvaziar)</span>':'');
    $('meventos').textContent=(d.eventos||[]).map(e=>horaLocal(e.em)+' ['+e.status+'] '+e.programa+' '+(e.idProduto||'')+' ← '+e.origem+(e.destino?' → '+e.destino:'')+(e.detalhe?' ('+e.detalhe+')':'')).join('\\n')||'(sem eventos)';
  }catch(e){}
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
  console.log(`gerenciador em http://localhost:${PORT} (rede: substitua localhost pelo IP)`);
  iniciarFilaWorker();
  iniciarClientesWorker();
  console.log(`fila anti-rajada ativa: 1 envio a cada ${intervaloFila()}s`);
});
