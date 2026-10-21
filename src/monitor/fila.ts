/**
 * Fila de reenvio (anti-rajada) — E6 / RF-036.
 *
 * Regra: quando uma origem publica VÁRIAS mensagens em pouco tempo, elas vão
 * para a espera e são liberadas **uma a cada intervalo fixo** (default 45s).
 * Evita disparar 10 posts de uma vez — risco de ban e de poluir o grupo.
 *
 * Persistida em data/monitor-fila.json (sobrevive a restart do manager).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enviarParaGrupo } from "../wa/dispatch.js";
import { carregarMonitor } from "./grupos.js";
import { limparMidiaAntiga } from "./midia.js";
import { registrarEvento } from "./state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");
const file = join(dataDir, "monitor-fila.json");

export interface ItemFila {
  id: string;
  origem: string;
  programa: string;
  idProduto: string | null;
  link: string;
  mensagem: string;
  imagem: string;
  /** de onde veio a foto (ex.: "foto da origem" / "foto do anúncio") */
  fonte?: string;
  destinos: string[];
  criadoEm: string;
}

interface StoreFila {
  itens: ItemFila[];
  ultimoEnvio: string | null;
}

let cache: StoreFila | null = null;

function carregar(): StoreFila {
  try {
    if (!existsSync(file)) return cache ?? { itens: [], ultimoEnvio: null };
    const raw: any = JSON.parse(readFileSync(file, "utf8"));
    cache = {
      itens: Array.isArray(raw?.itens) ? raw.itens : [],
      ultimoEnvio: raw?.ultimoEnvio ?? null,
    };
    return cache;
  } catch {
    return cache ?? { itens: [], ultimoEnvio: null };
  }
}

function salvar(s: StoreFila): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    cache = s;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, file); // atômico
  } catch {
    /* ignore */
  }
}

/** Intervalo entre liberações da fila de rajada (env, default 120s = 2 min). */
export function intervaloMs(): number {
  const s = Number(process.env.MONITOR_FILA_INTERVALO_S ?? 120);
  return (Number.isFinite(s) && s > 0 ? s : 120) * 1000;
}

export function intervaloFila(): number {
  return Math.round(intervaloMs() / 1000);
}

export function tamanhoFila(): number {
  return carregar().itens.length;
}

export function itensFila(): ItemFila[] {
  return carregar().itens;
}

export function limparFila(): number {
  const s = carregar();
  const n = s.itens.length;
  s.itens = [];
  salvar(s);
  return n;
}

export function enfileirar(item: Omit<ItemFila, "id" | "criadoEm">): ItemFila {
  const s = carregar();
  const novo: ItemFila = { ...item, id: randomUUID(), criadoEm: new Date().toISOString() };
  s.itens.push(novo);
  salvar(s);
  return novo;
}

// --- rajada: > 3 mensagens da MESMA origem dentro de 1 minuto ---------------
const JANELA_RAJADA_MS = 60_000;
const LIMITE_RAJADA = 3;
const recentes = new Map<string, number[]>();

/**
 * Conta a mensagem na janela de 1 minuto e responde se a origem estourou o
 * limite (4ª em diante). Só as excedentes vão para a fila; as 3 primeiras
 * seguem direto. Estado em memória: restart zera a janela (a fila persiste).
 */
export function ehRajada(origem: string, agora = Date.now()): boolean {
  const arr = (recentes.get(origem) ?? []).filter((t) => agora - t < JANELA_RAJADA_MS);
  arr.push(agora);
  recentes.set(origem, arr);
  return arr.length > LIMITE_RAJADA;
}

/** Envia um item para todos os destinos e registra evento por destino. */
export async function entregarItem(
  item: Omit<ItemFila, "id" | "criadoEm">
): Promise<{ jid: string; messageId: string }[]> {
  const dry = process.env.MONITOR_DRY === "1"; // rede de segurança
  const enviados: { jid: string; messageId: string }[] = [];
  for (const jid of item.destinos) {
    try {
      const r = await enviarParaGrupo({
        grupo: jid,
        imagem: item.imagem,
        legenda: item.mensagem,
        dryRun: dry,
      });
      enviados.push({ jid, messageId: r.messageId });
      registrarEvento({
        em: new Date().toISOString(), origem: item.origem, programa: item.programa,
        idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
        status: "ENCAMINHADA", messageId: r.messageId,
        detalhe: dry ? `${item.fonte ?? ""} (dry)`.trim() : item.fonte,
      });
    } catch (e: any) {
      registrarEvento({
        em: new Date().toISOString(), origem: item.origem, programa: item.programa,
        idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
        status: "ERRO", detalhe: String(e?.message ?? e).slice(0, 120),
      });
    }
  }
  return enviados;
}

/**
 * Libera o próximo item se (a) há item, (b) o envio direto está ligado e
 * (c) já passou o intervalo desde a última liberação.
 * Devolve o item liberado (ou null).
 */
export async function liberarProximo(): Promise<ItemFila | null> {
  const s = carregar();
  if (!s.itens.length) return null;
  if (!carregarMonitor().autoEnviar) return null; // pausado: mantém na fila
  const desde = s.ultimoEnvio ? Date.now() - new Date(s.ultimoEnvio).getTime() : Infinity;
  if (desde < intervaloMs()) return null;

  const item = s.itens.shift()!;
  s.ultimoEnvio = new Date().toISOString();
  salvar(s); // já sai da fila (não reenvia em loop se o envio falhar)

  await entregarItem(item);
  return item;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Worker: verifica a cada 5s e libera 1 item por intervalo (45s). */
export function iniciarFilaWorker(tickMs = 5000): void {
  if (timer) return;
  let ticks = 0;
  timer = setInterval(() => {
    void liberarProximo();
    // faxina das fotos da origem 1x por hora
    if (++ticks % 720 === 0) limparMidiaAntiga(3);
  }, tickMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}

export function pararFilaWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
