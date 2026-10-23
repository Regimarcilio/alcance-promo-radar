/**
 * Fila de reenvio (anti-rajada) — RF-043.
 *
 * Regra: quando uma origem publica VÁRIAS mensagens em pouco tempo, elas vão
 * para a espera e são liberadas **uma a cada intervalo fixo** (default 120s).
 *
 * Persistida em data/monitor-fila.json (sobrevive a restart do manager).
 * O item em envio fica em `emAndamento` até a conclusão; no boot, ele volta
 * para a fila em vez de se perder.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { enviarParaGrupo, ehErroTransitorio } from "../wa/dispatch.js";
import { registrarPublicacao } from "../store/publicacoes.js";
import { carregarMonitor } from "./grupos.js";
import { limparMidiaAntiga } from "./midia.js";
import { registrarEvento } from "./state.js";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";

const file = join(dataDirAtual(), "monitor-fila.json");

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
  /** quantas vezes o envio falhou e o item voltou para a fila */
  tentativas?: number;
}

interface StoreFila {
  itens: ItemFila[];
  ultimoEnvio: string | null;
  emAndamento?: { item: ItemFila; desde: string } | null;
}

let cache: StoreFila | null = null;
let processando: Promise<void> | null = null;

function blank(): StoreFila {
  return { itens: [], ultimoEnvio: null, emAndamento: null };
}

function carregar(): StoreFila {
  const raw = lerJson<any>(file, null);
  if (!raw || typeof raw !== "object") return cache ?? blank();
  cache = {
    itens: Array.isArray(raw.itens) ? raw.itens : [],
    ultimoEnvio: raw.ultimoEnvio ?? null,
    emAndamento: raw.emAndamento?.item ? raw.emAndamento : null,
  };
  return cache;
}

function salvar(s: StoreFila): void {
  cache = s;
  gravarJsonAtomico(file, s);
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

/**
 * Devolve um item para a fila preservando-o (mesmo id, mesma oferta).
 * Se ele ainda estiver em `emAndamento`, entra como cópia; se já estiver na
 * fila, apenas atualiza destinos/tentativas (evita duplicar).
 */
export function reenfileirar(item: ItemFila): ItemFila {
  const s = carregar();
  const existente = s.itens.find((i) => i.id === item.id);
  if (existente) {
    existente.destinos = item.destinos;
    existente.tentativas = item.tentativas;
  } else {
    s.itens.push({ ...item });
  }
  salvar(s);
  return item;
}

/** No boot: devolve à fila o item que estava sendo enviado quando caiu. */
export function recuperarEmAndamento(): number {
  const s = carregar();
  const pendente = s.emAndamento?.item;
  if (!pendente) return 0;
  if (!s.itens.some((i) => i.id === pendente.id)) s.itens.unshift(pendente);
  s.emAndamento = null;
  salvar(s);
  return 1;
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

/**
 * Envia um item para todos os destinos e registra evento por destino.
 * Falha transitória reenfileira o destino que falhou + os ainda não tentados
 * (sem duplicar os que já receberam). Falha permanente segue para o próximo.
 */
export async function entregarItem(
  item: ItemFila
): Promise<{ jid: string; messageId: string }[]> {
  const dry = process.env.MONITOR_DRY === "1"; // rede de segurança
  const enviados: { jid: string; messageId: string }[] = [];

  for (let i = 0; i < item.destinos.length; i += 1) {
    const jid = item.destinos[i];
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
      // RASTREIO: link publicado (com a tag de afiliado) para cruzar com o
      // painel de comissão do programa.
      if (!dry) {
        try {
          registrarPublicacao({
            em: new Date().toISOString(),
            programa: (item.programa === "shopee" || item.programa === "amazon" || item.programa === "kabum"
              ? item.programa
              : "desconhecido") as "shopee" | "amazon" | "kabum" | "desconhecido",
            categoria: item.origem,
            grupo: jid,
            id: item.idProduto ?? "",
            titulo: "",
            preco: 0,
            link: item.link,
            tag: item.link.includes("tag=") ? item.link.split("tag=")[1].split("&")[0] : undefined,
            via: "monitor",
          });
        } catch {
          /* rastreio é acessório */
        }
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const tentativas = (item.tentativas ?? 0) + 1;
      if (ehErroTransitorio(msg) && tentativas <= 3) {
        // Reenfileira do destino que falhou em diante: os anteriores já
        // receberam e NÃO podem ser repetidos.
        const restantes = item.destinos.slice(i);
        registrarEvento({
          em: new Date().toISOString(), origem: item.origem, programa: item.programa,
          idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
          status: "ERRO", detalhe: `reenfileirado (${tentativas}/3): ${msg.slice(0, 90)}`,
        });
        reenfileirar({ ...item, tentativas, destinos: restantes });
        return enviados;
      }
      registrarEvento({
        em: new Date().toISOString(), origem: item.origem, programa: item.programa,
        idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
        status: "ERRO", detalhe: msg.slice(0, 120),
      });
      // falha permanente: tenta os demais destinos
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
  if (processando) return null;
  const s = carregar();
  if (s.emAndamento) return null; // já há um envio em curso
  if (!s.itens.length) return null;
  if (!carregarMonitor().autoEnviar) return null; // pausado: mantém na fila

  const desde = s.ultimoEnvio ? Date.now() - new Date(s.ultimoEnvio).getTime() : Infinity;
  if (desde < intervaloMs()) return null;

  const item = s.itens.shift()!;
  s.ultimoEnvio = new Date().toISOString();
  s.emAndamento = { item, desde: s.ultimoEnvio };
  salvar(s);

  processando = (async () => {
    try {
      await entregarItem(item);
    } finally {
      const atual = carregar();
      if (atual.emAndamento?.item.id === item.id) {
        atual.emAndamento = null;
        salvar(atual);
      }
    }
  })();
  try {
    await processando;
  } finally {
    processando = null;
  }
  return item;
}

/** Aguarda o envio em curso terminar (usado no shutdown gracioso). */
export async function aguardarProcessamento(timeoutMs = 30_000): Promise<void> {
  if (!processando) return;
  await Promise.race([
    processando,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Worker: verifica a cada 5s e libera 1 item por intervalo. */
export function iniciarFilaWorker(tickMs = 5000): void {
  if (timer) return;
  recuperarEmAndamento();
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
