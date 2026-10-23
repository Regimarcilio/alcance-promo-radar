/**
 * CLIENTES — contatos por celular + listas de distribuição + disparo avulso.
 *
 * Fonte dos contatos: participantes dos grupos do número pareado
 * (`GET /group/participants/{instance}?groupJid=`), deduplicados por telefone,
 * + cadastro manual. O disparo usa o dispatch normal (rotação de números).
 *
 * Persistência: data/clientes.json (contatos/listas) e data/clientes-fila.json
 * (campanha em andamento — sobrevive a restart).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enviarParaGrupo } from "../wa/dispatch.js";
import { instanciaParaServico } from "../wa/rotacao.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ALCANCE_DATA_DIR permite smoke/teste em diretório temporário sem tocar no estado real.
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const file = join(dataDir, "clientes.json");
const filaFile = join(dataDir, "clientes-fila.json");

export interface Contato {
  jid: string;
  nome: string;
  telefone: string;
  /** grupo de onde veio (ou "manual") */
  origem: string;
  criadoEm: string;
}

export interface Lista {
  id: string;
  nome: string;
  contatos: string[];
  criadoEm: string;
}

interface Store {
  contatos: Contato[];
  listas: Lista[];
  ultimoSync: string | null;
}

interface ItemCampanha {
  id: string;
  jid: string;
  nome: string;
  texto: string;
  imagem: string;
  criadoEm: string;
}

interface StoreFila {
  itens: ItemCampanha[];
  ultimoEnvio: string | null;
  enviados: number;
  erros: number;
}

let cache: Store | null = null;
let cacheFila: StoreFila | null = null;

function carregar(): Store {
  try {
    if (!existsSync(file)) return cache ?? { contatos: [], listas: [], ultimoSync: null };
    const raw: any = JSON.parse(readFileSync(file, "utf8"));
    cache = {
      contatos: Array.isArray(raw?.contatos) ? raw.contatos : [],
      listas: Array.isArray(raw?.listas) ? raw.listas : [],
      ultimoSync: raw?.ultimoSync ?? null,
    };
    return cache;
  } catch {
    return cache ?? { contatos: [], listas: [], ultimoSync: null };
  }
}

function salvar(s: Store): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    cache = s;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}

function carregarFila(): StoreFila {
  try {
    if (!existsSync(filaFile)) return cacheFila ?? { itens: [], ultimoEnvio: null, enviados: 0, erros: 0 };
    const raw: any = JSON.parse(readFileSync(filaFile, "utf8"));
    cacheFila = {
      itens: Array.isArray(raw?.itens) ? raw.itens : [],
      ultimoEnvio: raw?.ultimoEnvio ?? null,
      enviados: Number(raw?.enviados ?? 0),
      erros: Number(raw?.erros ?? 0),
    };
    return cacheFila;
  } catch {
    return cacheFila ?? { itens: [], ultimoEnvio: null, enviados: 0, erros: 0 };
  }
}

function salvarFila(s: StoreFila): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    cacheFila = s;
    const tmp = `${filaFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, filaFile);
  } catch {
    /* ignore */
  }
}

// ---------- contatos ----------

/** Só dígitos; completa o DDI 55 quando vier DDD+número (10/11 dígitos). */
export function normalizarTelefone(bruto: string): string {
  const d = String(bruto ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

export function listarContatos(): Contato[] {
  return carregar().contatos;
}

export function listarListas(): Lista[] {
  return carregar().listas;
}

export interface EstadoSync {
  rodando: boolean;
  feitos: number;
  total: number;
  contatos: number;
  ultimoSync: string | null;
  /** grupos que falharam (ex.: rate limit do WhatsApp) */
  erros?: number;
  /** descrição do último erro */
  ultimoErro?: string | null;
}

let sincronizando = false;
let progresso = { feitos: 0, total: 0, erros: 0, ultimoErro: null as string | null };

export function estadoSync(): EstadoSync {
  const s = carregar();
  return {
    rodando: sincronizando,
    feitos: progresso.feitos,
    total: progresso.total,
    contatos: s.contatos.length,
    ultimoSync: s.ultimoSync,
    erros: progresso.erros,
    ultimoErro: progresso.ultimoErro,
  };
}

async function instanciaPadrao(): Promise<string> {
  // Operação de serviço (ler grupos p/ sincronizar contatos) = número principal.
  try {
    return await instanciaParaServico();
  } catch {
    return process.env.EVO_INSTANCE ?? "radar-piloto";
  }
}

// Ritmo do sync (ver sintaticar()).
const PAUSA_GRUPOS_MS = Number(process.env.SYNC_PAUSA_MS ?? 8000); // respiro entre grupos
const BACKOFF_MS = Number(process.env.SYNC_BACKOFF_MS ?? 90000); // espera quando o WhatsApp limita

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Busca os participantes de um grupo, com 1 retry quando o WhatsApp limita.
 *
 * O Evolution devolve HTTP 500 (payload genérico "Internal Server Error")
 * quando o Baileys toma 429 "rate-overlimit" na groupMetadata — por isso
 * 429 e 500 são tratados como "talvez rate limit": espera e tenta de novo.
 * 403 (forbidden) = grupo sem permissão de leitura: pula sem retry.
 */
async function buscarParticipantes(
  base: string,
  key: string,
  inst: string,
  groupJid: string,
): Promise<{ ok: boolean; dados: any | null; limite: boolean; erro: string | null }> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(
        `${base}/group/participants/${inst}?groupJid=${encodeURIComponent(groupJid)}`,
        { headers: { apikey: key }, signal: ctrl.signal },
      ).finally(() => clearTimeout(t));
      const texto = await r.text();
      if (r.ok) {
        let dados: any = {};
        try {
          dados = JSON.parse(texto || "{}");
        } catch {
          /* corpo inválido: segue sem participantes */
        }
        return { ok: true, dados, limite: false, erro: null };
      }
      const pareceLimite = r.status === 429 || r.status === 500;
      if (pareceLimite && tentativa === 0) {
        await dormir(BACKOFF_MS);
        continue;
      }
      return {
        ok: false,
        dados: null,
        limite: pareceLimite,
        erro: `Evolution ${r.status}`,
      };
    } catch {
      return { ok: false, dados: null, limite: false, erro: "timeout/rede" };
    }
  }
  return { ok: false, dados: null, limite: true, erro: "rate limit" };
}

/**
 * Varre os grupos do número e importa os participantes como contatos.
 * Preserva nomes já cadastrados; nunca remove ninguém. Roda em background
 * (a UI acompanha por estadoSync()).
 *
 * RITMO (importante): cada consulta de participantes dispara uma groupMetadata
 * no WhatsApp. Sem pausa entre grupos, 30+ consultas seguidas estouram o
 * rate limit do WhatsApp (429 "rate-overlimit" no Evolution, HTTP 500) e o sync
 * termina sem capturar quase nada. Por isso: pausa entre grupos + backoff
 * quando o WhatsApp limita + registro dos erros para a UI mostrar.
 */
export async function sincronizar(): Promise<{ novos: number; total: number }> {
  if (sincronizando) throw new Error("sincronização já em andamento");
  sincronizando = true;
  progresso = { feitos: 0, total: 0, erros: 0, ultimoErro: null };
  try {
    const base = (process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
    const key = process.env.EVO_KEY ?? "";
    const inst = await instanciaPadrao();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const rg = await fetch(`${base}/group/fetchAllGroups/${inst}?getParticipants=false`, {
      headers: { apikey: key },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!rg.ok) throw new Error(`Evolution ${rg.status}`);
    const grupos: any[] = await rg.json();
    const lista = Array.isArray(grupos) ? grupos : [];
    progresso.total = lista.length;

    const s = carregar();
    const existentes = new Set(s.contatos.map((c) => c.jid));
    let novos = 0;
    for (let i = 0; i < lista.length; i++) {
      const g = lista[i];
      const r = await buscarParticipantes(base, key, inst, g.id);
      if (r.ok && r.dados) {
        for (const p of Array.isArray(r.dados?.participants) ? r.dados.participants : []) {
          const raw = p?.phoneNumber || (String(p?.id ?? "").includes("@s.whatsapp.net") ? p.id : "");
          if (!raw) continue; // @lid sem telefone não serve para envio
          const jid = String(raw);
          if (existentes.has(jid)) continue;
          existentes.add(jid);
          s.contatos.push({
            jid,
            telefone: jid.split("@")[0],
            nome: "",
            origem: String(g.subject ?? g.id ?? ""),
            criadoEm: new Date().toISOString(),
          });
          novos++;
        }
      } else if (r.erro) {
        // grupo inacessível (403) não é erro de verdade; rate limit é.
        if (r.limite) {
          progresso.erros++;
          progresso.ultimoErro = `rate limit do WhatsApp em "${String(g.subject ?? g.id).slice(0, 40)}"`;
        }
      }
      progresso.feitos++;
      salvar(s); // progresso persistido a cada grupo
      // Respiro entre grupos: o WhatsApp limita consultas de metadados em rajada.
      if (i < lista.length - 1) await dormir(PAUSA_GRUPOS_MS);
    }
    s.ultimoSync = new Date().toISOString();
    salvar(s);
    return { novos, total: s.contatos.length };
  } finally {
    sincronizando = false;
  }
}

export function adicionarContato(nome: string, telefone: string, origem = "manual"): Contato {
  const tel = normalizarTelefone(telefone);
  if (tel.length < 12 || tel.length > 15) throw new Error("telefone inválido (use DDD + número)");
  const jid = `${tel}@s.whatsapp.net`;
  const s = carregar();
  const ja = s.contatos.find((c) => c.jid === jid);
  if (ja) {
    if (nome && nome !== ja.nome) {
      ja.nome = nome;
      salvar(s);
    }
    return ja;
  }
  const novo: Contato = { jid, nome: String(nome ?? "").trim(), telefone: tel, origem, criadoEm: new Date().toISOString() };
  s.contatos.push(novo);
  salvar(s);
  return novo;
}

export function renomearContato(jid: string, nome: string): boolean {
  const s = carregar();
  const c = s.contatos.find((x) => x.jid === jid);
  if (!c) return false;
  c.nome = String(nome ?? "").trim();
  salvar(s);
  return true;
}

export function removerContato(jid: string): boolean {
  const s = carregar();
  const n = s.contatos.length;
  s.contatos = s.contatos.filter((c) => c.jid !== jid);
  // tira das listas também
  s.listas.forEach((l) => (l.contatos = l.contatos.filter((j) => j !== jid)));
  salvar(s);
  return s.contatos.length < n;
}

// ---------- listas ----------

export function criarLista(nome: string, contatos: string[]): Lista {
  const n = String(nome ?? "").trim();
  if (!n) throw new Error("dê um nome à lista");
  const s = carregar();
  const validos = new Set(s.contatos.map((c) => c.jid));
  const nova: Lista = {
    id: randomUUID(),
    nome: n,
    contatos: [...new Set((contatos ?? []).filter((j) => validos.has(j)))],
    criadoEm: new Date().toISOString(),
  };
  s.listas.push(nova);
  salvar(s);
  return nova;
}

export function removerLista(id: string): boolean {
  const s = carregar();
  const n = s.listas.length;
  s.listas = s.listas.filter((l) => l.id !== id);
  salvar(s);
  return s.listas.length < n;
}

// ---------- campanha ----------

/** Intervalo entre contatos (env CLIENTES_INTERVALO_S, default 60s). */
export function intervaloClientesMs(): number {
  const s = Number(process.env.CLIENTES_INTERVALO_S ?? 60);
  return (Number.isFinite(s) && s > 0 ? s : 60) * 1000;
}

export function intervaloClientes(): number {
  return Math.round(intervaloClientesMs() / 1000);
}

export function estadoFilaClientes(): { pendentes: number; enviados: number; erros: number; intervalo: number } {
  const s = carregarFila();
  return { pendentes: s.itens.length, enviados: s.enviados, erros: s.erros, intervalo: intervaloClientes() };
}

/** Coloca 1 mensagem por contato na fila (não envia na hora). */
export function enfileirarCampanha(args: { texto: string; imagem?: string; jids: string[] }): number {
  const texto = String(args.texto ?? "").trim();
  if (!texto) throw new Error("escreva a propaganda");
  const jids = [...new Set((args.jids ?? []).filter(Boolean))];
  if (!jids.length) throw new Error("selecione pelo menos 1 contato");
  const s = carregarFila();
  const contatos = carregar().contatos;
  for (const jid of jids) {
    const c = contatos.find((x) => x.jid === jid);
    s.itens.push({
      id: randomUUID(),
      jid,
      nome: c?.nome || c?.telefone || jid.split("@")[0],
      texto,
      imagem: String(args.imagem ?? "").trim(),
      criadoEm: new Date().toISOString(),
    });
  }
  salvarFila(s);
  return s.itens.length;
}

export function limparFilaClientes(): number {
  const s = carregarFila();
  const n = s.itens.length;
  s.itens = [];
  salvarFila(s);
  return n;
}

/** Libera o próximo contato se já passou o intervalo. */
export async function liberarProximoCliente(): Promise<ItemCampanha | null> {
  const s = carregarFila();
  if (!s.itens.length) return null;
  const desde = s.ultimoEnvio ? Date.now() - new Date(s.ultimoEnvio).getTime() : Infinity;
  if (desde < intervaloClientesMs()) return null;

  const item = s.itens.shift()!;
  s.ultimoEnvio = new Date().toISOString();
  salvarFila(s); // sai da fila antes de tentar (não reenvia em loop)

  const dry = process.env.MONITOR_DRY === "1";
  try {
    const r = await enviarParaGrupo({ grupo: item.jid, imagem: item.imagem, legenda: item.texto, dryRun: dry });
    s.enviados++;
    salvarFila(s);
    console.log(`[clientes] enviado para ${item.nome} (${item.jid}) id=${r.messageId}`);
  } catch (e: any) {
    s.erros++;
    salvarFila(s);
    console.log(`[clientes] ERRO para ${item.nome} (${item.jid}): ${String(e?.message ?? e).slice(0, 120)}`);
  }
  return item;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Worker: checa a cada 5s e libera 1 contato por intervalo. */
export function iniciarClientesWorker(tickMs = 5000): void {
  if (timer) return;
  timer = setInterval(() => void liberarProximoCliente(), tickMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}

export function pararClientesWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
