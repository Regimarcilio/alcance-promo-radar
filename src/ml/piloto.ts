/**
 * PILOTO AUTOMÁTICO MULTI-LOOP (máx 5 simultâneos).
 * Cada loop: etiqueta + categoria + grupo + ciclo fixo de 2 min.
 * Fontes: hunt LIVE → cesta da categoria → espera (NUNCA finge).
 *
 * Concorrência: UM store em memória por processo (carregar uma vez no
 * boot). Recarregar o arquivo a cada chamada causava lost-update entre
 * ticks (loops sumindo) — nunca faça isso aqui.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import catsJson from "../categorias.json" with { type: "json" };
import { hunt } from "../hunter/service.js";
import { rankear } from "../scorer.js";
import type { Oportunidade } from "../hunter/schema.js";
import { converterLink } from "./provider.js";
import { resolver, lerMapa, grupoPara } from "./contas.js";
import { gerarHeadline } from "../ai/gateway.js";
import { formatar } from "../wa/formatter.js";
import { jaEnviado, registrarEnvio } from "../store/dedup.js";
import { enviarParaGrupo } from "../wa/dispatch.js";
import { completarCandidato, tituloDoSlug } from "./item-page.js";

const CATS = catsJson as { id: string; name: string }[];
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const pilotoFile = join(dataDir, "piloto.json");
const cestaFile = join(dataDir, "cestas.json");

export const MAX_LOOPS = 5;
// Ritmo humano: 2 ofertas aleatórias a cada 5 min; a cada 55 min de
// trabalho, pausa 8 min e recomeça (respiro anti-padrão-robô).
export const CICLO_MIN = 5;
export const POR_CICLO = 2;
export const TRABALHA_MIN = 55;
export const PAUSA_MIN = 8;
// Quarentena por TIPO: mandou TV, TV descansa 24h (1 de cada tipo).
// Quarentena por TIPO: mandou TV, TV descansa (padrão 24h, ajustável via QUARENTENA_H).
const quarentenaH = (): number => Number(process.env.QUARENTENA_H ?? 24);
const ESPERA_ENTRE_MS: [number, number] = [35000, 55000]; // ~45s com jitter: exato demais denuncia robô

export interface PilotoCfg {
  conta: string;
  category: string;
  grupo: string;
  minMin: number;
  maxMin: number;
  sub?: string; // subcategoria (folha ML); vazio = categoria inteira
  qtd?: number; // postagens por ciclo: 1 ou 2 (default 2)
  intervaloS?: number; // segundos entre elas: 45–90 (default 60, ±10s humano)
}

export interface LoopState extends PilotoCfg {
  id: number;
  rodando: boolean;
  iniciadaEm: string | null;
  ultimaMsg: string | null;
  proximaEm: string | null;
  enviadas: number;
  cicloInicio: string | null;
  giro?: number; // rotação de páginas da caça (18 itens por página)
}

interface Store {
  loops: LoopState[];
  logs: string[];
}

const timers = new Map<number, NodeJS.Timeout>();

// ---------- store único em memória ----------

function blankLoop(): LoopState {
  return {
    id: 0, conta: "", category: "MLB3937", grupo: "",
    minMin: CICLO_MIN, maxMin: CICLO_MIN, rodando: false,
    iniciadaEm: null, ultimaMsg: null, proximaEm: null, enviadas: 0,
    cicloInicio: null,
  };
}

function embaralhar<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tipoFile = join(root, "data", "tipos.json");

/** Tipo do item: folha ML quando há, senão assinatura das 3 palavras-chave. */
export function tipoDe(op: { titulo: string; [k: string]: any }): string {
  const leaf = op.catLeaf as string | undefined;
  if (leaf) return `leaf:${leaf}`;
  const stop = new Set(["de", "com", "para", "em", "por", "sem", "uma", "dos", "das", "nos", "nas", "que", "mais", "super", "original", "oferta"]);
  const toks = op.titulo
    .toLowerCase()
    .replace(/[^a-z0-9áàâãéèêíïóôõöúçñ ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 3);
  return `t:${toks.join("-") || "?"}`;
}

function lerTipos(): Record<string, Record<string, number>> {
  try {
    return JSON.parse(readFileSync(tipoFile, "utf8"));
  } catch {
    return {};
  }
}

function emCooldown(category: string, tipo: string): boolean {
  const ts = lerTipos()[category]?.[tipo];
  if (!ts) return false;
  return Date.now() - ts < quarentenaH() * 3600000;
}

/** Idade em horas desde o último envio do tipo (null = nunca enviado). */
function idadeTipoH(category: string, tipo: string): number | null {
  const ts = lerTipos()[category]?.[tipo];
  if (!ts) return null;
  return (Date.now() - ts) / 3600000;
}

function marcarTipo(category: string, tipo: string): void {
  mkdirSync(dataDir, { recursive: true });
  const all = lerTipos();
  if (!all[category]) all[category] = {};
  all[category][tipo] = Date.now();
  writeFileSync(tipoFile, JSON.stringify(all, null, 2));
}

let mem: Store | null = null;

function store(): Store {
  if (mem) return mem;
  let s: Store = { loops: [], logs: [] };
  let pausados = 0;
  try {
    if (existsSync(pilotoFile)) {
      const raw = JSON.parse(readFileSync(pilotoFile, "utf8"));
      if (Array.isArray(raw.loops)) {
        // reinício pausa tudo por segurança — e PERSISTE a pausa (antes o arquivo
        // continuava com rodando:true e a grade parecia ligada sem estar).
        pausados = (raw.loops as LoopState[]).filter((l) => l.rodando).length;
        s = {
          loops: (raw.loops as LoopState[]).map((l) => ({ ...blankLoop(), ...l, rodando: false })),
          logs: Array.isArray(raw.logs) ? raw.logs : [],
        };
      } else if (raw && typeof raw === "object" && ("category" in raw || "conta" in raw)) {
        s = { loops: [], logs: Array.isArray(raw.logs) ? raw.logs : [] };
      }
    }
  } catch {
    /* padrão */
  }
  mem = s;
  if (pausados > 0) {
    log(`⏸ ${pausados} loop(s) pausado(s) após reinício — clique em ▶ START (ou ▶ LIGA TUDO) para religar.`);
    salvar();
  }
  return mem;
}

function salvar(): void {
  if (!mem) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pilotoFile, JSON.stringify(mem, null, 2));
}

function log(msg: string): void {
  const s = store();
  const agora = new Date();
  const linha = `${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} ${msg}`;
  s.logs.push(linha);
  s.logs = s.logs.slice(-40);
  console.log(`[piloto] ${linha}`);
  salvar();
  // Registro em logs/ (1 arquivo por dia, histórico permanente)
  try {
    const logDir = join(root, "logs");
    mkdirSync(logDir, { recursive: true });
    const dia = agora.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    appendFileSync(join(logDir, `piloto-${dia}.log`), `${dia} ${linha}\n`);
  } catch {
    /* log em arquivo é melhor esforço */
  }
}

const entre = (a: number, b: number) => a + Math.random() * (b - a);

// ---------- cesta (links colados 1 vez por categoria) ----------

export interface ItemCesta {
  url: string;
  adicionadaEm: string;
  titulo?: string;
  precoPix?: number;
  precoDe?: number;
  imagem?: string;
}

export function lerCesta(category: string): ItemCesta[] {
  try {
    const all = JSON.parse(readFileSync(cestaFile, "utf8"));
    return all[category] ?? [];
  } catch {
    return [];
  }
}

/**
 * Aceita por linha: URL | pix | de | titulo | imagem (só a URL é
 * obrigatória; foto vai junto na mensagem quando informada ou puxada).
 */
export function salvarCesta(category: string, urls: string[]): { novos: number; atualizados: number } {
  mkdirSync(dataDir, { recursive: true });
  let all: Record<string, ItemCesta[]> = {};
  try {
    all = JSON.parse(readFileSync(cestaFile, "utf8"));
  } catch {
    /* nova */
  }
  const atual = all[category] ?? [];
  const vistos = new Set(atual.map((i) => i.url));
  let novos = 0;
  let atualizados = 0;
  for (const linha of urls.map((x) => x.trim()).filter(Boolean)) {
    const [u, pix, de, titulo, imagem] = linha.split("|").map((x) => x.trim());
    if (!/^https?:\/\//.test(u)) continue;
    const num = (x: string) => (x && Number(x) > 0 ? Number(x) : undefined);
    const existente = atual.find((i) => i.url === u);
    if (existente) {
      // o doc é a fonte da verdade: completa campos faltantes
      let mexeu = false;
      if (num(pix) && !existente.precoPix) { existente.precoPix = num(pix); mexeu = true; }
      if (num(de) && !existente.precoDe) { existente.precoDe = num(de); mexeu = true; }
      if (titulo && !existente.titulo) { existente.titulo = titulo; mexeu = true; }
      if (imagem && /^https?:\/\//.test(imagem) && !existente.imagem) { existente.imagem = imagem; mexeu = true; }
      if (mexeu) atualizados++;
      vistos.add(u);
      continue;
    }
    const item: ItemCesta = { url: u, adicionadaEm: new Date().toISOString() };
    if (num(pix)) item.precoPix = num(pix);
    if (num(de)) item.precoDe = num(de);
    if (titulo) item.titulo = titulo;
    if (imagem && /^https?:\/\//.test(imagem)) item.imagem = imagem;
    atual.push(item);
    vistos.add(u);
    novos++;
  }
  all[category] = atual;
  writeFileSync(cestaFile, JSON.stringify(all, null, 2));
  return { novos, atualizados };
}

export function limparCesta(category: string): void {
  try {
    const all = JSON.parse(readFileSync(cestaFile, "utf8"));
    delete all[category];
    writeFileSync(cestaFile, JSON.stringify(all, null, 2));
  } catch {
    /* nada */
  }
}

// ---------- candidatos ----------

function daCesta(category: string): Oportunidade[] {
  return lerCesta(category).map((item, i) => ({
    mlbId: `CESTA-${i}-${Buffer.from(item.url).toString("base64").slice(0, 12)}`,
    titulo: item.titulo || tituloDoSlug(item.url) || item.url,
    imagem: item.imagem || "",
    precoDe: item.precoDe ?? null,
    precoAtual: item.precoPix ?? 0,
    cupom: null,
    vendidos: 0,
    avaliacao: 0,
    link: item.url,
    descontoPct: 0,
    score: 50 - i,
    motivo: "cesta da categoria",
    selo: "OFERTA BOA" as const,
  }));
}

// ---------- uma passada (por loop) ----------

async function tick(id: number): Promise<void> {
  const s = store();
  const loop = s.loops.find((l) => l.id === id);
  if (!loop || !loop.rodando) return;
  const catName = CATS.find((c) => c.id === loop.category)?.name ?? loop.category;
  const tag = `#${loop.id}`;
  // 🌙 Pausa noturna 23h–8h (JANELA_INICIO/FIM no .env): gente dorme, robô não.
  // Agenda o despertar para as 8h em vez de checar a cada 5 min a noite toda.
  const horaLocal = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(new Date())
  );
  const ini = Number(process.env.JANELA_INICIO ?? 8);
  const fim = Number(process.env.JANELA_FIM ?? 23);
  if (horaLocal < ini || horaLocal >= fim) {
    const agora = new Date();
    const sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const alvo = new Date(sp);
    alvo.setHours(ini, Math.floor(Math.random() * 20), 0, 0);
    if (alvo.getTime() <= sp.getTime()) alvo.setDate(alvo.getDate() + 1);
    const diffMs = alvo.getTime() - sp.getTime();
    // loga 1x por noite (só se a última linha não for a da pausa)
    const ultima = s.logs[s.logs.length - 1] ?? "";
    if (!ultima.includes("pausa noturna")) {
      log(`${tag} 🌙 pausa noturna (${fim}h–${ini}h) — recomeço às ${ini}h.`);
    }
    if (timers.get(loop.id)) clearTimeout(timers.get(loop.id)!);
    loop.proximaEm = new Date(Date.now() + diffMs).toISOString();
    salvar();
    timers.set(loop.id, setTimeout(() => tick(loop.id), diffMs));
    return;
  }
  try {
    // Sem limite diário (removido a pedido) e sem paradas 8h–23h:
    // valem dedup 7d, janela de horário e kill-switch. Quarentena virou
    // preferência (frescos primeiro), nunca bloqueio.
    // Gira as páginas (0,18,…,342) + alterna a ordenação: centenas de itens
    // viram rodízio em vez de repetir os mesmos 18. Volta ao início no giro 20.
    const giro = (loop.giro ?? 0) % 20;
    loop.giro = (loop.giro ?? 0) + 1;
    const sorts = ["relevance", "lowest_price", "highest_price"];
    const sort = sorts[(loop.giro ?? 1) % 3];
    const { candidatos, mock } = await hunt({
      category: loop.category, q: "", descontoMin: 0, soComCupom: false, teto: 1e9, limite: 20,
      sub: loop.sub ?? "", offset: giro * 18, sort,
    });
    let fonte = "";
    let lista: Oportunidade[];
    if (!mock && candidatos.length > 0) {
      lista = rankear(candidatos, 0, 0);
      fonte = "caça LIVE";
    } else {
      // VITRINE (perfil social): produtos reais com preço+foto, sem bloqueio
      const { colher, lerMapaVitrine } = await import("./vitrine.js");
      const mapaV = lerMapaVitrine();
      let vit: Oportunidade[] = [];
      try {
        const itens = await colher();
        vit = itens
          .filter((v) => mapaV[v.catLeaf] === loop.category && !jaEnviado(v.mlbId, v.preco, null))
          .map((v, i) => ({
            mlbId: v.mlbId,
            titulo: v.titulo,
            imagem: v.foto,
            precoDe: null as number | null,
            precoAtual: v.preco,
            cupom: null as string | null,
            vendidos: 0,
            avaliacao: 0,
            link: v.url,
            descontoPct: 0,
            score: 70 - i,
            motivo: "vitrine ML",
            selo: "OFERTA BOA" as const,
            catLeaf: v.catLeaf,
          }) as Oportunidade & { catLeaf: string });
      } catch (e: any) {
        log(`${tag} vitrine indisponível (${e.message?.split(".")[0] ?? "?"}).`);
      }
      if (vit.length > 0) {
        lista = vit;
        fonte = "vitrine";
      } else {
        // mesma chave do registrarEnvio (mlbId+preço+cupom) — sem ela, reenvia!
        const cesta = daCesta(loop.category).filter((o) => !jaEnviado(o.mlbId, o.precoAtual, o.cupom));
        if (cesta.length === 0) {
          log(mock
            ? `${tag} sem novidades: busca bloqueada + cesta vazia — aguardando (nada fake enviado).`
            : `${tag} cesta esgotada por 7 dias — cole mais links ou aguarde.`);
          agendar(loop);
          return;
        }
        lista = cesta;
        fonte = "cesta";
      }
    }
    // Quarentena como PREFERÊNCIA (nunca trava 8h–23h): frescos primeiro;
    // se só restar tipo em quarentena, usa o mais antigo e avisa.
    // (Dedup 7d do item exato continua valendo sempre.)
    const frescos = lista.filter((op) => !emCooldown(loop.category, tipoDe(op)));
    const esfriando = lista
      .filter((op) => emCooldown(loop.category, tipoDe(op)))
      .map((op) => ({ op, idade: idadeTipoH(loop.category, tipoDe(op)) ?? 0 }))
      .sort((a, b) => b.idade - a.idade)
      .map((x) => x.op);
    if (esfriando.length > 0 && frescos.length === 0) {
      log(`${tag} flexibilizando quarentena: usando o tipo mais antigo em vez de parar.`);
    }
    lista = [...frescos, ...esfriando];
    if (lista.length === 0) {
      // sem candidatos em nenhuma fonte — único caso em que aguarda
      log(`${tag} sem candidatos em nenhuma fonte — aguardando próxima volta.`);
      agendar(loop);
      return;
    }
    // 2 ofertas ALEATÓRIAS E VARIADAS por ciclo: embaralha e exige
    // baixa similaridade com o que já saiu neste ciclo (nunca 2 TVs).
    const tokens = (t: string): Set<string> => {
      const stop = new Set(["de", "com", "para", "em", "por", "sem", "uma", "com", "dos", "das", "nos", "nas", "que", "mais", "super", "original"]);
      return new Set(
        t.toLowerCase().replace(/[^a-z0-9áàâãéèêíïóôõöúçñ ]/gi, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w))
      );
    };
    const parecidos = (a: string, b: string): boolean => {
      const A = tokens(a);
      const B = tokens(b);
      if (A.size === 0 || B.size === 0) return false;
      let inter = 0;
      for (const w of A) if (B.has(w)) inter++;
      return inter / Math.min(A.size, B.size) >= 0.5;
    };
    let enviadasAqui = 0;
    const titulosCiclo: string[] = [];
    const folhasCiclo: string[] = [];
    const qtd = loop.qtd === 1 ? 1 : 2;
    const gapS = Math.min(90, Math.max(45, loop.intervaloS ?? 60));
    for (const op of embaralhar(lista).slice(0, 8)) {
      if (enviadasAqui >= qtd) break;
      const leaf = (op as any).catLeaf as string | undefined;
      if (leaf && folhasCiclo.includes(leaf)) {
        log(`${tag} pulado ${op.mlbId}: mesma subcategoria do ciclo (variedade).`);
        continue;
      }
      if (titulosCiclo.some((t) => parecidos(t, op.titulo))) {
        log(`${tag} pulado ${op.mlbId}: parecido demais com o já enviado no ciclo (variedade).`);
        continue;
      }
      try {
        const enrich = await converterLink(op.link, { conta: loop.conta || undefined, category: loop.category });
        if (enrich.fonte !== "conversor") {
          log(`${tag} pulado ${op.mlbId}: sem link real (${enrich.aviso?.split(".")[0] ?? "?"}).`);
          continue;
        }
        let titulo = op.titulo;
        let imagem = op.imagem;
        let precoDe = op.precoDe;
        let precoPix = op.precoAtual;
        if (fonte === "cesta" || !op.precoAtual) {
          const real = await completarCandidato({ ...op, link: op.link });
          if (real.titulo && real.titulo !== op.link) titulo = real.titulo;
          if (real.imagem) imagem = real.imagem;
          if (real.precoAtual) {
            precoPix = real.precoAtual;
            precoDe = real.precoDe ?? precoDe;
          }
        }
        if (!precoPix) {
          log(`${tag} pulado ${op.mlbId}: sem preço — tento preencher sozinho a cada ciclo; ou complete na cesta (URL | pix | de).`);
          continue;
        }
        // trava dupla anti-duplicidade (outro loop pode ter enviado no meio tempo)
        if (jaEnviado(op.mlbId, precoPix, op.cupom)) {
          log(`${tag} pulado ${op.mlbId}: já enviado (DUPLICADO_7D).`);
          continue;
        }
        const conta = resolver(loop.category, loop.conta || undefined).nome;
        // Cupom (ordem): manual do item > código registrado > cupom ML da categoria
        let cupom = op.cupom;
        if (!cupom) {
          const { codigoPara, nomeCodigo, cupomPara } = await import("./cupons.js");
          const code = codigoPara(loop.category, conta);
          if (code) {
            const nm = nomeCodigo(loop.category, conta);
            cupom = nm ? `${code} (${nm})` : code;
            log(`${tag} 🎟️ código ${code} anexado.`);
          } else {
            const achado = await cupomPara(loop.category);
            if (achado) {
              cupom = `${achado.titulo}${achado.minimo ? ` (${achado.minimo})` : ""}`;
              log(`${tag} 🎟️ cupom ML "${achado.titulo}" anexado (aplicável na página).`);
            }
          }
        }
        const { headline, subtitulo } = gerarHeadline({ ...op, titulo });
        const mensagem = formatar({
          headline, subtitulo, nome: titulo, precoDe, precoPix,
          cupom, link: enrich.linkAfiliado,
          categoria: `${catName} • auto`, score: op.score,
        });
      const r = await enviarParaGrupo({ grupo: loop.grupo, imagem, legenda: mensagem, dryRun: false });
      registrarEnvio(op.mlbId, precoPix, cupom);
      marcarTipo(loop.category, tipoDe({ ...op, titulo }));
        loop.enviadas++;
        loop.ultimaMsg = new Date().toISOString();
        log(`${tag} ✅ [${fonte}|${conta}] "${titulo.slice(0, 50)}" → ${loop.grupo} id=${r.messageId} (${enviadasAqui + 1}/${qtd})${/^https?:\/\//.test(imagem) ? " 📷" : ""}`);
        enviadasAqui++;
        titulosCiclo.push(titulo);
        const leafSent = (op as any).catLeaf as string | undefined;
        if (leafSent) folhasCiclo.push(leafSent);
        if (enviadasAqui < qtd) {
          // intervalo escolhido (45–90s) com ±10s humanos
          await esperar((gapS + (Math.random() * 20 - 10)) * 1000);
          continue;
        }
        agendar(loop);
        return;
      } catch (e: any) {
        // 1 candidato com erro (ex.: foto) não mata o ciclo — tenta o próximo
        log(`${tag} falha em ${op.mlbId} (${e.message?.slice(0, 80) ?? "?"}), tentando próximo.`);
        continue;
      }
    }
    if (enviadasAqui === 0) {
      log(`${tag} nenhum candidato com link real nesta passada — aguardando.`);
    } else {
      log(`${tag} ciclo com ${enviadasAqui} envio(s).`);
    }
  } catch (e: any) {
    log(`${tag} erro na passada: ${e.message} — tentando de novo no próximo ciclo.`);
  }
  agendar(loop);
}

function agendar(loop: LoopState): void {
  if (!loop.rodando) return;
  const t = timers.get(loop.id);
  if (t) clearTimeout(t);
  const agora = Date.now();
  if (!loop.cicloInicio) loop.cicloInicio = new Date(agora).toISOString();
  const decorridoMin = (agora - new Date(loop.cicloInicio).getTime()) / 60000;
  let min: number;
  if (decorridoMin >= TRABALHA_MIN) {
    // ☕ respiro: 8 min parado a cada 55 min, depois recomeça o ciclo
    min = PAUSA_MIN;
    loop.cicloInicio = new Date(agora + PAUSA_MIN * 60000).toISOString();
    log(`#${loop.id} ☕ pausa de ${PAUSA_MIN} min após ${TRABALHA_MIN} min — recomeço em instantes.`);
  } else {
    min = CICLO_MIN; // ritmo normal fixo
  }
  loop.proximaEm = new Date(agora + min * 60000).toISOString();
  salvar();
  timers.set(loop.id, setTimeout(() => tick(loop.id), min * 60000));
}

// ---------- API ----------

export function status() {
  const s = store();
  const mapa: Record<string, number> = {};
  for (const c of CATS) {
    const n = lerCesta(c.id).length;
    if (n > 0) mapa[c.id] = n;
  }
  return {
    max: MAX_LOOPS,
    rodando: s.loops.filter((l) => l.rodando).length,
    loops: s.loops,
    logs: [...s.logs].reverse(),
    cestas: mapa,
  };
}

export function start(cfg: PilotoCfg, agora = false): LoopState {
  // conta pode vir vazia: o tick resolve pelo mapa da categoria → padrão
  if (!cfg.category) throw new Error("Escolha a categoria.");
  if (!cfg.grupo) throw new Error("Escolha o grupo.");
  if (cfg.conta) resolver(cfg.category, cfg.conta); // valida conta existente
  const s = store();
  const ativos = s.loops.filter((l) => l.rodando);
  if (ativos.length >= MAX_LOOPS) throw new Error(`Limite de ${MAX_LOOPS} loops simultâneos — pare um antes.`);
  const id = s.loops.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  const loop: LoopState = {
    ...blankLoop(), id,
    conta: cfg.conta, category: cfg.category, grupo: cfg.grupo,
    sub: cfg.sub ?? "",
    qtd: cfg.qtd === 1 ? 1 : 2,
    intervaloS: Math.min(90, Math.max(45, cfg.intervaloS ?? 60)),
    minMin: cfg.minMin || 2, maxMin: cfg.maxMin || 2,
    rodando: true, iniciadaEm: new Date().toISOString(),
  };
  s.loops.push(loop);
  log(`#${id} ▶️ START etiqueta=${loop.conta || "(mapa)"} categoria=${loop.category} grupo=${loop.grupo} ${loop.qtd}x a cada 5min / ${loop.intervaloS}s entre elas (${ativos.length + 1}/${MAX_LOOPS})`);
  const esperaMs = agora ? 2000 : entre(loop.minMin, loop.maxMin) * 60000;
  loop.proximaEm = new Date(Date.now() + esperaMs).toISOString();
  salvar();
  timers.set(id, setTimeout(() => tick(id), esperaMs));
  return loop;
}

/**
 * LIGA TUDO: um loop por categoria mapeada (conta+grupo do mapa),
 * até o teto de 5. Zero escolha — lê os vínculos salvos e sai enviando.
 */
export function ligarTudo(): { ligados: LoopState[]; pulados: string[] } {
  const mapa = lerMapa();
  const categorias = Object.keys(mapa);
  const ligados: LoopState[] = [];
  const pulados: string[] = [];
  const s = store();
  for (const category of categorias) {
    if (s.loops.some((l) => l.category === category && l.rodando)) {
      pulados.push(`${category}: já rodando`);
      continue;
    }
    if (s.loops.filter((l) => l.rodando).length >= MAX_LOOPS) {
      pulados.push(`${category}: teto de ${MAX_LOOPS} loops`);
      continue;
    }
    const grupo = grupoPara(category);
    if (!grupo.includes("@")) {
      pulados.push(`${category}: sem grupo amarrado`);
      continue;
    }
    try {
      ligados.push(start({ conta: "", category, grupo, sub: mapa[category]?.sub ?? "", minMin: 2, maxMin: 2 }, true));
    } catch (e: any) {
      pulados.push(`${category}: ${e.message}`);
    }
  }
  if (ligados.length === 0 && pulados.length === 0) {
    throw new Error("Nenhuma categoria amarrada (conta+grupo). Configure em Contas.");
  }
  return { ligados, pulados };
}
export function stop(id?: number): void {
  const s = store();
  if (id == null) {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    s.loops = [];
    log("⏹️ STOP geral — grade zerada. Nada mais será enviado.");
  } else {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    s.loops = s.loops.filter((l) => l.id !== id);
    log(`#${id} ⏹️ parado e removido do grid.`);
  }
  salvar();
}
