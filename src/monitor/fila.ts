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
import { extrairPrecos } from "./produto.js";
import { extrairTitulo } from "./titulo.js";
import { registrarEvento } from "./state.js";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";
import { criarEnvelope } from "../messaging/envelope.js";
import { lerDlq, registrarDlq, removerDlq } from "../messaging/dlq.js";
import { deveRetentar, proximaTentativaEm } from "../messaging/politica.js";
import { publicarEvento } from "../messaging/eventos.js";
import { incrementar, observarLatencia } from "../messaging/contadores.js";
import { logger } from "../observability/logger.js";

// caminho resolvido em tempo de chamada (teste/smoke trocam ALCANCE_DATA_DIR)
function file(): string {
  return join(dataDirAtual(), "monitor-fila.json");
}

/** Tipo da fila do Monitor na camada de Mensageria (DLQ compartilhada). */
export const TIPO_MONITOR = "monitor.encaminhar";

/** Nº máximo de tentativas (preserva o retry atual da fila do Monitor). */
export const MAX_TENTATIVAS = 3;

export interface ItemFila {
  id: string;
  origem: string;
  programa: string;
  idProduto: string | null;
  link: string;
  mensagem: string;
  /** título do produto postado (para o rastreio; `null` = extrai do corpo) */
  titulo?: string | null;
  /** categoria/programa do Alcance (no rastreio; ausente = usa o programa) */
  categoria?: string | null;
  imagem: string;
  /** de onde veio a foto (ex.: "foto da origem" / "foto do anúncio") */
  fonte?: string;
  destinos: string[];
  criadoEm: string;
  /** quantas vezes o envio falhou e o item voltou para a fila */
  tentativas?: number;
  /** ISO da próxima tentativa (backoff exponencial com jitter) */
  proximaTentativaEm?: string | null;
  /** correlação do fluxo (webhook → fila → envio → evento) */
  correlationId?: string | null;
  /** último erro de envio (preenchido quando o item vai para a DLQ) */
  ultimoErro?: string | null;
  /** quantas vezes o operador reprocessou este item a partir da DLQ */
  reprocessos?: number;
}

interface StoreFila {
  itens: ItemFila[];
  ultimoEnvio: string | null;
  emAndamento?: { item: ItemFila; desde: string } | null;
  /** mensagens processadas com sucesso (ACK) */
  processadas?: number;
  /** mensagens que foram para a DLQ */
  falhas?: number;
}

let cache: StoreFila | null = null;
let processando: Promise<void> | null = null;

function blank(): StoreFila {
  return { itens: [], ultimoEnvio: null, emAndamento: null };
}

function carregar(): StoreFila {
  const raw = lerJson<any>(file(), null);
  if (!raw || typeof raw !== "object") return cache ?? blank();
  cache = {
    itens: Array.isArray(raw.itens) ? raw.itens : [],
    ultimoEnvio: raw.ultimoEnvio ?? null,
    emAndamento: raw.emAndamento?.item ? raw.emAndamento : null,
    processadas: Number(raw.processadas ?? 0),
    falhas: Number(raw.falhas ?? 0),
  };
  return cache;
}

function salvar(s: StoreFila): void {
  cache = s;
  gravarJsonAtomico(file(), s);
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

/** Item atualmente em envio (null se não há nada em andamento). */
export function emAndamento(): ItemFila | null {
  return carregar().emAndamento?.item ?? null;
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
/** Programa interno (`mercadolivre`) → rótulo do rastreio (`ml`). */
const PROGRAMA_PUB: Record<string, "ml" | "shopee" | "amazon" | "kabum" | "desconhecido"> = {
  mercadolivre: "ml",
  ml: "ml",
  shopee: "shopee",
  amazon: "amazon",
  kabum: "kabum",
};

/** Resultado detalhado de uma entrega (usado pela fila com ACK). */
export interface ResultadoEntrega {
  /** destinos com envio confirmado */
  enviados: { jid: string; messageId: string }[];
  /** destinos que ainda NÃO receberam (a partir do que falhou) */
  restantes: string[];
  /** último erro encontrado */
  erro: string | null;
  /** o erro que interrompeu a entrega foi transitório? */
  transitorio: boolean;
  /** item atualizado (destinos restantes + tentativas) */
  item: ItemFila;
}

/**
 * Entrega o item aos destinos, **sem** decidir o destino da falha.
 * Quem chama decide: a fila (ACK/NACK/DLQ) ou o caminho direto do webhook
 * (que reenfileira como sempre).
 */
export async function entregarItemDetalhado(item: ItemFila): Promise<ResultadoEntrega> {
  const dry = process.env.MONITOR_DRY === "1"; // rede de segurança
  const enviados: { jid: string; messageId: string }[] = [];
  let erro: string | null = null;
  let transitorio = false;
  let restantes: string[] = [];

  for (let i = 0; i < item.destinos.length; i += 1) {
    const jid = item.destinos[i];
    try {
      const r = await enviarParaGrupo({
        grupo: jid,
        imagem: item.imagem,
        legenda: item.mensagem,
        dryRun: dry,
        fluxo: "monitor",
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
          const programa = PROGRAMA_PUB[item.programa] ?? "desconhecido";
          registrarPublicacao({
            em: new Date().toISOString(),
            programa,
            categoria: item.categoria ?? programa,
            grupo: jid,
            id: item.idProduto ?? "",
            // Título do produto postado (como no piloto). Itens antigos da fila,
            // gravados antes deste campo existir, têm o título extraído do corpo.
            titulo: item.titulo?.trim() || extrairTitulo(item.mensagem) || "",
            preco: extrairPrecos(item.mensagem).precoAtual ?? 0,
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
      const ehTransitorio = ehErroTransitorio(msg);
      if (ehTransitorio) {
        // Reenfileira do destino que falhou em diante: os anteriores já
        // receberam e NÃO podem ser repetidos.
        restantes = item.destinos.slice(i);
        erro = msg;
        transitorio = true;
        registrarEvento({
          em: new Date().toISOString(), origem: item.origem, programa: item.programa,
          idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
          status: "ERRO", detalhe: `reenfileirado (${(item.tentativas ?? 0) + 1}/${MAX_TENTATIVAS}): ${msg.slice(0, 90)}`,
        });
        break; // os destinos seguintes esperam o retry
      }
      registrarEvento({
        em: new Date().toISOString(), origem: item.origem, programa: item.programa,
        idProduto: item.idProduto, linkTransformado: item.link, destino: jid,
        status: "ERRO", detalhe: msg.slice(0, 120),
      });
      // falha permanente: o destino vai para a DLQ (não se perde) e o item
      // segue para os demais destinos
      erro = msg;
      registrarDlqMonitor(item, jid, msg, (item.tentativas ?? 0) + 1, "erro não transitório");
    }
  }
  return {
    enviados,
    restantes,
    erro,
    transitorio,
    item: { ...item, destinos: restantes, tentativas: item.tentativas ?? 0 },
  };
}

/** Registra um destino que morreu na DLQ (com motivo e id próprio). */
function registrarDlqMonitor(
  item: ItemFila,
  destino: string,
  erro: string,
  tentativas: number,
  motivo: string,
): void {
  const id = `${item.id}:${destino}`;
  const env = criarEnvelope(TIPO_MONITOR, { item, destino }, {
    id,
    tentativas,
    correlationId: item.correlationId ?? undefined,
  });
  registrarDlq({
    id,
    tipo: TIPO_MONITOR,
    envelope: env,
    motivo,
    ultimoErro: erro,
    tentativas,
    ultimaTentativaEm: new Date().toISOString(),
    origem: item.origem ?? null,
  });
  // EVENTO: a mensagem foi para a DLQ (painel/auditoria podem acompanhar)
  try {
    publicarEvento(
      "mensagem.dlq",
      { tipo: TIPO_MONITOR, id, motivo, tentativas },
      { correlationId: item.correlationId ?? undefined },
    );
  } catch {
    /* evento é acessório */
  }
}

/**
 * Entrega o item e devolve os destinos enviados.
 * Caminho direto (webhook): em falha transitória **reenfileira** como
 * sempre — comportamento histórico preservado.
 */
export async function entregarItem(
  item: ItemFila
): Promise<{ jid: string; messageId: string }[]> {
  const r = await entregarItemDetalhado(item);
  if (r.transitorio && r.restantes.length) {
    const tentativas = (item.tentativas ?? 0) + 1;
    reenfileirar({ ...item, tentativas, destinos: r.restantes });
  }
  return r.enviados;
}

/**
 * Libera o próximo item se (a) há item, (b) o envio direto está ligado e
 * (c) já passou o intervalo desde a última liberação.
 *
 * SEMÂNTICA DE ACK (issue #49): o item **fica na fila** enquanto é enviado
 * (marcado em `emAndamento`) e só sai no ACK (todos os destinos entregues).
 * Falha transitória → volta para a fila com `tentativas + 1` (retry de 3
 * tentativas, como antes); erro permanente ou tentativas esgotadas → **DLQ**
 * com o motivo (nunca se perde).
 */
export async function liberarProximo(): Promise<ItemFila | null> {
  if (processando) return null;
  const s = carregar();
  if (s.emAndamento) return null; // já há um envio em curso
  if (!s.itens.length) return null;
  if (!carregarMonitor().autoEnviar) return null; // pausado: mantém na fila

  const desde = s.ultimoEnvio ? Date.now() - new Date(s.ultimoEnvio).getTime() : Infinity;
  if (desde < intervaloMs()) return null;

  // NÃO tira da fila: o item só sai no ACK
  // (ignora item esperando o backoff da última tentativa)
  const agoraMs = Date.now();
  const item =
    s.itens.find((i) => {
      if (!i.proximaTentativaEm) return true;
      const quando = Date.parse(i.proximaTentativaEm);
      return !Number.isFinite(quando) || quando <= agoraMs;
    }) ?? null;
  if (!item) return null;
  const agora = new Date().toISOString();
  s.ultimoEnvio = agora;
  s.emAndamento = { item, desde: agora };
  salvar(s);

  processando = (async () => {
    const inicio = Date.now();
    try {
      const r = await entregarItemDetalhado(item);
      // OBSERVABILIDADE (issue #52): latência + log com o correlationId
      const duracaoMs = Date.now() - inicio;
      observarLatencia("alcance_msg_latencia_envio_ms", { tipo: TIPO_MONITOR }, duracaoMs);
      incrementar("alcance_msg_processadas_total", {
        tipo: TIPO_MONITOR,
        resultado: r.restantes.length ? "erro" : "ok",
      });
      logger.info(
        {
          tipo: TIPO_MONITOR,
          chave: item.id,
          correlationId: item.correlationId ?? null,
          ok: !r.restantes.length,
          tentativas: item.tentativas ?? 0,
          duracaoMs,
          erro: r.erro ? r.erro.slice(0, 200) : null,
        },
        "[mensageria] mensagem processada",
      );
      const atual = carregar();
      if (atual.emAndamento?.item.id !== item.id) return; // já recuperado

      if (!r.restantes.length) {
        // ACK: todos os destinos receberam → o item sai da fila
        atual.itens = atual.itens.filter((i) => i.id !== item.id);
        atual.emAndamento = null;
        atual.processadas = (atual.processadas ?? 0) + 1;
        salvar(atual);
        return;
      }

      const tentativas = (item.tentativas ?? 0) + 1;
      if (r.transitorio && deveRetentar(r.erro ?? "", tentativas)) {
        incrementar("alcance_msg_retries_total", { tipo: TIPO_MONITOR });
        // NACK: reenfileira do destino que falhou (sem duplicar o item),
        // com backoff exponencial (evita rajada contra o WhatsApp)
        reenfileirar({
          ...item,
          tentativas,
          destinos: r.restantes,
          proximaTentativaEm: proximaTentativaEm(tentativas),
        });
        const depois = carregar();
        depois.emAndamento = null;
        salvar(depois);
        return;
      }

      // esgotou as tentativas (ou erro permanente): DLQ com o motivo
      registrarDlqMonitor(item, r.restantes[0], r.erro ?? "falha", tentativas,
        r.transitorio ? "tentativas esgotadas" : "erro não transitório");
      atual.itens = atual.itens.filter((i) => i.id !== item.id);
      atual.emAndamento = null;
      atual.falhas = (atual.falhas ?? 0) + 1;
      salvar(atual);
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

/**
 * Reprocessa um item da DLQ do Monitor: ele volta para a fila de reenvio.
 * Só volta por ação explícita do operador.
 *
 * O item volta com `tentativas: 0` (o reenvio conta do zero), mas **preserva
 * o `ultimoErro`** (auditoria) e **incrementa `reprocessos`** (quantas vezes
 * o operador reparou a mensagem).
 */
export function reprocessarDlq(id: string): boolean {
  const item = removerDlq(id);
  if (!item) return false;
  if (item.tipo !== TIPO_MONITOR) return false;
  const payload = item.envelope.payload as any;
  const original = payload?.item as ItemFila | undefined;
  if (!original) return false;
  const ultimoErro = item.ultimoErro ?? item.envelope.ultimoErro ?? null;
  const reprocessos = Number(item.envelope.reprocessos ?? 0) + 1;
  const s = carregar();
  const existente = s.itens.find((i) => i.id === original.id);
  if (existente) {
    existente.destinos = original.destinos;
    existente.tentativas = 0;
    existente.ultimoErro = ultimoErro;
    existente.reprocessos = reprocessos;
  } else {
    s.itens.push({ ...original, tentativas: 0, ultimoErro, reprocessos });
  }
  salvar(s);
  return true;
}

/** Itens da DLQ do Monitor. */
export function dlqMonitor(): ReturnType<typeof lerDlq> {
  return lerDlq(TIPO_MONITOR);
}

/** Estatísticas da fila do Monitor (pendentes/processadas/falhas/DLQ). */
export function statsMonitor(): {
  pendentes: number;
  processadas: number;
  falhas: number;
  dlq: number;
  maisAntigaEm: string | null;
} {
  const s = carregar();
  const maisAntiga = s.itens.reduce<string | null>(
    (min, i) => (!min || i.criadoEm < min ? i.criadoEm : min),
    null
  );
  return {
    pendentes: s.itens.length,
    processadas: s.processadas ?? 0,
    falhas: s.falhas ?? 0,
    dlq: dlqMonitor().length,
    maisAntigaEm: maisAntiga,
  };
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
