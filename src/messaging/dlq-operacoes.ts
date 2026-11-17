/**
 * AÇÕES DA DLQ — o que o operador pode fazer com uma mensagem morta.
 *
 * Três ações, todas **explícitas** (nada volta sozinho):
 * - **reprocessar**: devolve o item para a fila de origem;
 * - **reprocessar em lote**: devolve vários itens (por tipo ou por lista de
 *   ids), respeitando o filtro visível na tela;
 * - **descartar**: remove o item da DLQ — **destrutivo**, sem volta.
 *
 * Regras que valem para as três:
 * - o item volta com `tentativas: 0` (o consumidor conta do zero), **mas**
 *   preserva o `ultimoErro` (auditoria) e incrementa `reprocessos`;
 * - **nada é enviado aqui**: o lote só **reenfileira**. Os itens seguem o
 *   ritmo normal da fila (1 a cada `CLIENTES_INTERVALO_S`, dentro da janela
 *   comercial) — reprocessar em lote **não** vira rajada;
 * - toda ação fica registrada na auditoria (`data/auditoria-mensageria.json`)
 *   com tipo, chave, motivo e `correlationId`.
 */
import { getBroker } from "./broker.js";
import { itensDlq } from "./filas.js";
import { removerDlq, type ItemDLQ } from "./dlq.js";
import { registrarAuditoriaAcao } from "./consumidores.js";
import { TIPO_MONITOR, reprocessarDlq } from "../monitor/fila.js";
import { classificarMidia } from "../monitor/midia.js";
import { definirFalhasDisparo, descontaFalhaDisparo, listarDisparos } from "../clientes/disparos.js";

/**
 * Estado da mídia local de um item da DLQ.
 *
 * - `ok` — mídia presente (ou não há mídia): reprocessa como está;
 * - `sumiu` — o arquivo foi removido pela faxina de retenção: o item é
 *   reenviado **só com o texto** (a mídia é acessória e o link da oferta
 *   tem valor). Sem isso, o reprocessamento só produzia nova DLQ (issue #82);
 * - `invalida` — caminho fora de `data/midia`/nome inválido: violação de
 *   segurança, o reprocessamento é **recusado**.
 */
type EstadoMidiaDlq = "ok" | "sumiu" | "invalida";

function estadoMidiaDlq(item: ItemDLQ): EstadoMidiaDlq {
  const p = item.envelope?.payload as any;
  const img = String(p?.imagem ?? "");
  if (!img) return "ok";
  if (/^https?:\/\//i.test(img) || img.startsWith("data:")) return "ok";
  const c = classificarMidia(img);
  if (c.ok) return "ok";
  return c.motivo === "inexistente" ? "sumiu" : "invalida";
}

/** Resultado padrão de uma ação sobre a DLQ. */
export interface ResultadoAcaoDlq {
  ok: boolean;
  /** erro (quando `ok` é falso) */
  erro?: string;
  /** quantos itens foram afetados */
  total: number;
  /** itens afetados (id + tipo) */
  itens?: { id: string; tipo: string }[];
  /** quantidade por tipo de fila */
  porTipo?: Record<string, number>;
}

/** Item da DLQ pelo id (procura em todos os tipos). */
export function itemNaDlq(id: string): ItemDLQ | null {
  const alvo = String(id ?? "").trim();
  if (!alvo) return null;
  return itensDlq().find((i) => i.id === alvo) ?? null;
}

/**
 * Remove o item da DLQ (**ação destrutiva** — a mensagem não volta para a
 * fila). Registra a ação na auditoria.
 */
export function descartarItemDlq(id: string): ResultadoAcaoDlq {
  const item = itemNaDlq(id);
  if (!item) return { ok: false, erro: "item não encontrado na DLQ", total: 0 };
  const removido = removerDlq(item.id);
  if (!removido) return { ok: false, erro: "item não encontrado na DLQ", total: 0 };
  registrarAuditoriaAcao({
    acao: "descartar",
    tipo: item.tipo,
    id: item.id,
    chave: item.envelope?.chave ?? null,
    motivo: item.motivo,
    correlationId: item.envelope?.correlationId ?? null,
    tentativas: item.tentativas,
    reprocessos: Number(item.envelope?.reprocessos ?? 0),
  });
  return { ok: true, total: 1, itens: [{ id: item.id, tipo: item.tipo }] };
}

/**
 * Devolve o item da DLQ para a fila de origem.
 *
 * O item volta **enfileirado** (não enviado): o consumidor o processa no
 * ritmo normal da fila. `tentativas` zera, `ultimoErro` é preservado e
 * `reprocessos` é incrementado.
 */
export async function reprocessarItemDlq(
  id: string,
  opts: { acao?: string } = {},
): Promise<ResultadoAcaoDlq> {
  const item = itemNaDlq(id);
  if (!item) return { ok: false, erro: "item não encontrado na DLQ", total: 0 };
  const acao = opts.acao ?? "reprocessar";

  if (item.tipo === TIPO_MONITOR) {
    // A fila do Monitor tem store próprio: o item volta para `data/monitor-fila.json`.
    const payload = item.envelope?.payload as any;
    if (!payload?.item) {
      return { ok: false, erro: "item da DLQ sem payload reconhecível", total: 0 };
    }
    const ok = reprocessarDlq(item.id);
    if (!ok) return { ok: false, erro: "não foi possível reprocessar o item", total: 0 };
  } else {
    const broker = getBroker();
    const midia = estadoMidiaDlq(item);
    if (midia === "invalida") {
      return {
        ok: false,
        erro: "mídia com caminho inválido (fora de data/midia) — reprocessamento recusado",
        total: 0,
      };
    }
    await broker.reprocessar(item.id);
    // confirma que o envelope voltou para a fila (a DLQ não pode "engolir" o item)
    let naFila = (broker.pendentes?.(item.tipo) ?? []).some((e) => e.id === item.id);
    if (!naFila) return { ok: false, erro: "não foi possível reprocessar o item", total: 0 };
    // A mídia sumiu (faxina de retenção): reenvia SÓ com o texto. Sem isto o
    // reprocessamento voltaria a morrer na DLQ pelo mesmo motivo (issue #82).
    if (midia === "sumiu" && broker.atualizar) {
      const alvo = (broker.pendentes?.(item.tipo) ?? []).find((e) => e.id === item.id);
      if (alvo) {
        const payload = { ...(alvo.payload as any) };
        payload.imagem = "";
        payload.midia = null;
        await broker.atualizar(item.id, { ...alvo, payload });
        naFila = true;
        console.warn(
          `[dlq] item ${item.id}: mídia removida pela retenção — reprocessado só com o texto`
        );
      }
    }
  }

  registrarAuditoriaAcao({
    acao,
    tipo: item.tipo,
    id: item.id,
    chave: item.envelope?.chave ?? null,
    motivo: item.motivo,
    correlationId: item.envelope?.correlationId ?? null,
    tentativas: item.tentativas,
    reprocessos: Number(item.envelope?.reprocessos ?? 0) + 1,
  });
  // O item volta para a fila: a falha que ele tinha no disparo não é mais
  // uma perda (o mesmo contato pode ser reenviado com sucesso). Sem esta
  // desconta, `enviados + falhas` passa do total e a campanha nunca fecha.
  if (item.origem) {
    try {
      descontaFalhaDisparo(item.origem);
    } catch { /* contador é acessório: nunca impede o reprocessamento */ }
  }
  return { ok: true, total: 1, itens: [{ id: item.id, tipo: item.tipo }] };
}

/** Filtro do reprocessamento em lote. */
export interface FiltroLoteDlq {
  /** reprocessa só os itens deste tipo de fila */
  tipo?: string | null;
  /** reprocessa só estes ids (o filtro por tipo também vale, se vier junto) */
  ids?: string[] | null;
}

/**
 * Reprocessa **vários** itens da DLQ de uma vez.
 *
 * Sem `tipo` nem `ids`: reprocessa tudo. Com `tipo`: só os itens daquele
 * tipo (é o filtro visível na tela). Com `ids`: só os indicados.
 *
 * De novo: o lote só **reenfileira** — o envio continua no ritmo normal da
 * fila (1 a cada `CLIENTES_INTERVALO_S`), nunca em rajada.
 */
export async function reprocessarLoteDlq(filtro: FiltroLoteDlq = {}): Promise<ResultadoAcaoDlq> {
  const todos = itensDlq();
  const ids = Array.isArray(filtro.ids) ? filtro.ids.map((i) => String(i).trim()).filter(Boolean) : [];
  const tipo = filtro.tipo ? String(filtro.tipo).trim() : "";

  let alvo = todos;
  if (ids.length) {
    const set = new Set(ids);
    alvo = alvo.filter((i) => set.has(i.id));
  }
  if (tipo) alvo = alvo.filter((i) => i.tipo === tipo);

  const porTipo: Record<string, number> = {};
  const afetados: { id: string; tipo: string }[] = [];
  for (const item of alvo) {
    const r = await reprocessarItemDlq(item.id, { acao: "reprocessar-lote" });
    if (!r.ok) continue;
    afetados.push({ id: item.id, tipo: item.tipo });
    porTipo[item.tipo] = (porTipo[item.tipo] ?? 0) + 1;
  }
  // Reconcilia os contadores dos disparos com a DLQ real (o lote inteiro
  // pode ter tirado mais de uma falha do mesmo disparo).
  reconciliarFalhasDisparos();
  return { ok: true, total: afetados.length, itens: afetados, porTipo };
}

/**
 * Reconcilia o contador de falhas dos disparos com a **DLQ real**:
 * `falhas` = mensagens do disparo que estão mortas agora.
 *
 * Corrige o caso em que o mesmo destinatário morreu, foi reprocessado e
 * morreu de novo (a falha era contada duas vezes, e o disparo nunca fechava
 * como CONCLUIDO).
 */
export function reconciliarFalhasDisparos(): { disparoId: string; falhas: number }[] {
  const mortos = new Map<string, number>();
  for (const item of itensDlq()) {
    const origem = item.origem ?? (item.envelope?.payload as any)?.disparoId ?? null;
    if (!origem) continue;
    mortos.set(String(origem), (mortos.get(String(origem)) ?? 0) + 1);
  }
  const afetados: { disparoId: string; falhas: number }[] = [];
  for (const d of listarDisparos()) {
    if (d.status === "CANCELADO") continue;
    const falhas = mortos.get(d.id) ?? 0;
    if (d.falhas === falhas) continue;
    try {
      definirFalhasDisparo(d.id, falhas);
      afetados.push({ disparoId: d.id, falhas });
    } catch { /* contador é acessório */ }
  }
  return afetados;
}
