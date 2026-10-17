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
import { registrarEvento } from "./state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const file = join(dataDir, "monitor-fila.json");

export interface ItemFila {
  id: string;
  origem: string;
  programa: string;
  idProduto: string | null;
  link: string;
  mensagem: string;
  imagem: string;
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

/** Intervalo fixo entre liberações (env MONITOR_FILA_INTERVALO_S, default 45s). */
export function intervaloMs(): number {
  const s = Number(process.env.MONITOR_FILA_INTERVALO_S ?? 45);
  return (Number.isFinite(s) && s > 0 ? s : 45) * 1000;
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

  for (const jid of item.destinos) {
    try {
      const r = await enviarParaGrupo({
        grupo: jid,
        imagem: item.imagem,
        legenda: item.mensagem,
        dryRun: false,
      });
      registrarEvento({
        em: new Date().toISOString(), origem: item.origem, programa: item.programa,
        idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
        status: "ENCAMINHADA", messageId: r.messageId,
      });
    } catch (e: any) {
      registrarEvento({
        em: new Date().toISOString(), origem: item.origem, programa: item.programa,
        idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
        status: "ERRO", detalhe: String(e?.message ?? e).slice(0, 120),
      });
    }
  }
  return item;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Worker: verifica a cada 5s e libera 1 item por intervalo (45s). */
export function iniciarFilaWorker(tickMs = 5000): void {
  if (timer) return;
  timer = setInterval(() => {
    void liberarProximo();
  }, tickMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}

export function pararFilaWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
