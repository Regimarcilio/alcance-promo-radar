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
  carregarMonitor, adicionarRegra, removerDestino, removerRegra, definirAutoEnviar,
  alternarOrigem, alternarDestino,
} from "../monitor/grupos.js";
import { processar as processarMonitor, extrairMensagem } from "../monitor/webhook.js";
import { eventos as eventosMonitor, resumo as resumoMonitor, zerarContadores, limparDedup } from "../monitor/state.js";
import { tamanhoFila, intervaloFila, limparFila, iniciarFilaWorker } from "../monitor/fila.js";
import { detectar as detectarOferta, rotulo as rotuloPrograma } from "../monitor/parser.js";
import {
  listarGrupos, estadoConexao, contaPareada, reiniciar, desconectar, configurarWebhook,
} from "../monitor/evolution.js";

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
        { conta: b.conta ?? "", category: b.category ?? "", grupo: b.grupo ?? "", sub: b.sub ?? "", qtd: b.qtd ?? 2, intervaloS: b.intervaloS ?? 60, minMin: 5, maxMin: 5 },
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
    try {
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
      json(200, {
        grupos: (Array.isArray(gs) ? gs : []).map((g: any) => ({
          id: g.id, nome: g.subject ?? g.name ?? g.id, tamanho: g.size ?? null,
        })),
      });
    } catch (e: any) {
      json(200, { grupos: [], aviso: `Evolution inacessível: ${e.message}` });
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
  if (req.method === "GET" && url.pathname === "/api/monitor/grupos") {
    const s = carregarMonitor();
    json(200, { regras: s.regras, autoEnviar: s.autoEnviar });
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
          appendFileSync("/app/data/debug-webhook.log", new Date().toISOString() + " " + JSON.stringify(p).slice(0, 1500) + "\n");
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

const PAGINA = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gerenciador — autoMensagemWhats</title>
<style>*{box-sizing:border-box;margin:0;padding:0;font-family:'Segoe UI',Roboto,Arial,sans-serif}
body{background:#0b141a;color:#e9edef;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px;margin-bottom:4px}h1 span{color:#00a884}.sub{color:#8696a0;font-size:13px;margin-bottom:14px}
.panel{background:#111b21;border:1px solid #222d34;border-radius:14px;padding:14px;margin-bottom:14px}
label{font-size:12px;color:#8696a0;display:block;margin:8px 0 4px}
select,input{width:100%;background:#0b141a;border:1px solid #2a3942;color:#e9edef;border-radius:10px;padding:10px;font-size:14px}
.grid2{display:grid;grid-template-columns:2fr 1fr;gap:10px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:700px){.grid2,.grid4{grid-template-columns:1fr 1fr}}
button{border:0;border-radius:10px;padding:11px 14px;font-weight:800;cursor:pointer}
.buscar{background:#00a884;color:#04241d;width:100%;margin-top:12px;font-size:15px}
.ghost{background:#202c33;color:#fff;width:100%;margin-top:12px;font-size:15px}
.badge{font-size:11px;font-weight:800;border-radius:20px;padding:3px 10px}
.live{background:#00a884;color:#04241d}.mock{background:#f9a825;color:#3d2b00}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:#111b21;border:1px solid #222d34;border-radius:14px;overflow:hidden}
.card img{width:100%;height:170px;object-fit:cover;background:#202c33;display:block}
.noimg{height:90px;display:flex;align-items:center;justify-content:center;font-size:40px;background:#202c33}
.info{padding:12px;font-size:13px}.info b.t{font-size:14px}
.preco{margin:6px 0}.de{text-decoration:line-through;color:#8696a0}.por{color:#00e676;font-weight:800;font-size:16px}
.meta{color:#8696a0;font-size:12px;margin:4px 0}.link{color:#53bdeb;word-break:break-all;font-size:12px}
.enviar{background:#00a884;color:#04241d;width:100%;margin-top:10px}
.result{background:#06281f;border:1px solid #00a884;border-radius:14px;padding:14px;margin-top:14px;font-size:13px;display:none}
.result code{background:#000;padding:2px 8px;border-radius:6px;color:#9ff0c8}
.hint{font-size:12px;color:#8696a0;margin:4px 0 8px}
.mrow{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0b141a;border:1px solid #222d34;border-radius:10px;padding:10px;margin-top:8px;flex-wrap:wrap}
.mbox{background:#0b141a;border:1px solid #222d34;border-radius:10px;padding:12px;margin-top:10px}
.mini{font-size:12px;color:#8696a0}.mini code{background:#000;padding:1px 5px;border-radius:5px;color:#9ff0c8}
.mbtn{background:#202c33;color:#fff;width:auto;margin:0;padding:7px 12px;font-size:12.5px;white-space:nowrap}
.mbtn.ok{background:#00a884;color:#04241d}
.regra{background:#0b141a;border:1px solid #2a3942;border-left:3px solid #53bdeb;border-radius:10px;padding:10px 12px;margin-top:8px}
.regra .orig{font-size:14px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.regra .dest{font-size:13px;margin:6px 0 0 14px;padding:4px 0 0 10px;border-left:1px solid #2a3942;display:flex;justify-content:space-between;gap:8px;align-items:center}
.ctrls{display:flex;gap:6px;align-items:center;flex-shrink:0}
.tgl{background:#202c33;color:#8696a0;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:800;cursor:pointer;border:1px solid #2a3942}
.tgl.on{background:#00a884;color:#04241d;border-color:#00a884}
.regra.off{opacity:.55}.regra.off .orig b{text-decoration:line-through}
.dest.off{opacity:.6}.dest.off b{text-decoration:line-through}
.jidtag{color:#8696a0;font-size:11px}
.malerta{border-radius:10px;padding:10px 12px;margin-top:10px;font-size:13px;border:1px solid}
.malerta.pare{background:#3a1d1d;border-color:#c0392b;color:#ffd0cb}
.malerta.warn{background:#3a3316;border-color:#b99a16;color:#ffeeb8}
.malerta.ok{background:#0f2f26;border-color:#00a884;color:#a8f0d8}
pre{background:#000;border-radius:10px;padding:10px;font-size:11.5px;white-space:pre-wrap;margin-top:8px;color:#d1f4cc;max-height:220px;overflow:auto}</style></head>
<body>
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
<div class="panel" style="border-color:#00a884">
<label>🚀 Piloto automático — 2 ofertas aleatórias a cada 5 min, sozinho</label>
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
</div>
<div style="display:flex;gap:8px;margin-top:8px"><button class="buscar" style="margin-top:0;flex:1" onclick="pilotoStart()">▶ START</button><button class="ghost" style="margin-top:0;flex:1" onclick="pilotoStop()">⏹ STOP TUDO</button></div>
<div id="pstatus" style="margin-top:8px;font-size:13px"></div>
<pre id="plog" style="max-height:140px"></pre>
<div class="grid2" style="margin-top:8px"><div><label>Cesta da categoria (cole 1 vez — rodízio automático com foto)</label><textarea id="cestatext" rows="3" style="width:100%;background:#0b141a;border:1px solid #2a3942;color:#e9edef;border-radius:10px;padding:8px" placeholder="URL | pix | de | título | foto (um por linha)"></textarea></div>
<div><label>&nbsp;</label><div id="cestainfo" style="font-size:12px;margin-bottom:8px"></div><div style="display:flex;gap:8px"><button class="buscar" style="margin-top:0" onclick="salvarCestaUI()">💾 Guardar links</button><button class="ghost" style="margin-top:0" onclick="limparCestaUI()">🗑 Limpar</button></div></div></div>
<div style="margin-top:10px"><label>🏬 Vitrine ML (ofertas reais com preço+foto — sem colar nada)</label>
<div class="hint">Folhas descobertas no perfil de afiliado. Amarre cada folha a uma categoria 1 vez → o piloto usa sozinho.</div>
<div id="vitrineout" style="font-size:13px">carregando vitrine…</div></div>
</div>
<div class="panel" style="border-color:#53bdeb">
<label>📡 Monitor — cada grupo de origem encaminha para os SEUS destinos</label>
<div class="hint">Oferta publicada numa <b>origem</b> (grupo de achadinhos que você monitora) tem o link trocado pelo <b>seu</b> e é reenviada <b>apenas</b> para os destinos amarrados àquela origem. Uma origem pode ter vários destinos.</div>

<div class="mrow">
<div><b id="mcontalabel">Conta WhatsApp: …</b><br><span class="mini" id="mcontaestado"></span></div>
<div style="display:flex;gap:8px"><button class="mbtn" onclick="reiniciarEvo()">↻ Reconectar</button><button class="mbtn" onclick="trocarCelular()">📱 Trocar celular</button></div></div>

<div class="mrow">
<div><b id="mautolabel">Envio direto — OFF (vai p/ revisão)</b><br><span class="mini">ON encaminha sozinho • OFF apenas registra para revisão</span></div>
<button class="mbtn" id="mautobtn" onclick="toggleAutoMonitor()">Ligar envio direto</button></div>
<div id="malerta"></div>

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
<div><label>Testar reconhecimento (cole a mensagem recebida)</label><textarea id="mteste" rows="3" style="width:100%;background:#0b141a;border:1px solid #2a3942;color:#e9edef;border-radius:10px;padding:8px" placeholder="Cole aqui uma mensagem com link de afiliado..."></textarea>
<div style="display:flex;gap:8px;margin-top:6px"><select id="mtesteorigem" style="flex:1"><option value="">primeira origem das regras</option></select><button class="mbtn ok" onclick="testarMonitor()">🧪 Testar</button></div>
<pre id="mtesteout"></pre></div>
<div><label>Últimos eventos do monitor</label><pre id="meventos" style="max-height:220px"></pre></div></div>
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
  carregarVitrine();
  carregarCupons();
  carregarMonitorUI();
  setInterval(function(){try{carregarMonitorStatus();}catch(e){}},15000);
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
  $('contasout').innerHTML=d.contas.map(c=>\`\${c.padrao?'★':'•'} <b>\${c.nome}</b> <small>\${c.tagMask}</small> <a href="#" style="color:#53bdeb" onclick="tornarPadrao('\${c.nome}');return false">tornar padrão</a>\`).join('<br>')||'Nenhuma conta — usando .env.';
  if(d.mapa&&d.mapa[$('mapcat').value]){const m=d.mapa[$('mapcat').value];$('mapconta').value=m.conta||'-';if(m.grupo)$('mapgrupo').value=m.grupo;if(m.sub)window._mapsub=m.sub;}
  carregarGrupos();carregarSubs('mapcat','mapsub',true);carregarSubs('pacat','pasub',false);
}
async function carregarGrupos(){
  const g=await (await fetch('/api/grupos')).json();
  const opts=(g.grupos||[]).map(function(x){return '<option value="'+x.id+'">'+x.nome+' ('+x.id.slice(0,12)+'…)</option>';}).join('');
  $('mapgrupo').innerHTML='<option value="">Grupo padrão (.env)</option>'+opts;
  $('pagrupo').innerHTML='<option value="">— escolha o grupo —</option>'+opts;
  atualizarPiloto();
}
setInterval(atualizarPiloto, 10000);
async function atualizarPiloto(){
  try{
    const s=await (await fetch('/api/piloto')).json();
    const n=(s.loops||[]).length;
    let html=n? '' : '⚪ nenhum loop — monte acima e aperte START.';
    (s.loops||[]).forEach(function(l){
      html+='<div style="border:1px solid #2a3942;border-radius:10px;padding:8px;margin:6px 0;font-size:12.5px">'
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
  const r=await (await fetch('/api/piloto/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conta:$('paconta').value,category:$('pacat').value,grupo:$('pagrupo').value,sub:$('pasub').value,qtd:Number($('paqtd').value),intervaloS:Number($('pagap').value)})})).json();
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
    renderMalerta(d.regras||[], on);
    carregarContaMonitor();
    carregarMonitorStatus();
  }catch(e){}
}
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
    if(!d.ok){$('mgruposinfo').innerHTML='<span style="color:#f8806a">'+(d.erro||'erro')+'</span>';return;}
    window.__wgrupos=d.grupos||[];
    const opts=window.__wgrupos.map(function(g){return '<option value="'+esc(g.jid)+'">'+esc(g.nome)+(g.tamanho!=null?' ('+g.tamanho+')':'')+'</option>';}).join('');
    $('mselOrigem').innerHTML='<option value="">— escolha a origem —</option>'+opts;
    $('mselDestino').innerHTML='<option value="">— escolha o destino —</option>'+opts;
    $('mgruposinfo').textContent=window.__wgrupos.length+' grupos carregados';
  }catch(e){$('mgruposinfo').innerHTML='<span style="color:#f8806a">erro: '+e.message+'</span>';}
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
    $('mfila').innerHTML='🚦 fila anti-rajada: <b>'+(d.fila||0)+'</b> em espera · liberando 1 a cada <b>'+(d.intervaloFila||45)+'s</b>'+(d.fila>0?' <span class="mini">(≈ '+Math.ceil((d.fila*(d.intervaloFila||45))/60)+' min p/ esvaziar)</span>':'');
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
  console.log(`fila anti-rajada ativa: 1 envio a cada ${intervaloFila()}s`);
});
