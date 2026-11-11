/**
 * DISPAROS — registro de campanhas enviadas para listas de clientes.
 *
 * Por que existe: a fila anti-bloqueio (clientes.ts) sabe o que ainda vai sair,
 * mas não guarda histórico. Aqui cada pedido de envio vira um DISPARO com
 * status e contadores, para a tela Clientes mostrar o grid com CRUD:
 * criar (envio), ler (grid), editar (só pendente), excluir e duplicar.
 *
 * Persistência: data/disparos.json (atômico, limite de 500 registros).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";

export const LIMITE_DISPAROS = 500;

export type StatusDisparo =
  | "PENDENTE"
  | "ENVIANDO"
  | "CONCLUIDO"
  | "PARCIAL"
  | "ERRO"
  | "CANCELADO";

export interface MidiaDisparo {
  /** caminho no disco (data/midia/<uuid>.<ext>) */
  arquivo: string;
  mime: string;
  tipo: "image" | "video";
  /** nome original do arquivo (só para exibir) */
  nome?: string;
}

export interface Disparo {
  id: string;
  em: string;
  atualizadoEm: string;
  listaId: string | null;
  listaNome: string | null;
  texto: string;
  /** link opcional, anexado no fim da mensagem */
  link: string | null;
  midia: MidiaDisparo | null;
  /** destinatários (1 mensagem por contato) */
  jids: string[];
  total: number;
  enviados: number;
  falhas: number;
  status: StatusDisparo;
  /**
   * Instância (número) que envia esta campanha (issue #45).
   * null/ausente = Automático (rodízio do fluxo "disparo").
   */
  instancia?: string | null;
  /** último erro relevante (UI mostra no detalhe) */
  erro?: string | null;
}

function arquivo(): string {
  return join(dataDirAtual(), "disparos.json");
}

function carregar(): Disparo[] {
  try {
    const raw: any = lerJson(arquivo(), []);
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.disparos) ? raw.disparos : [];
    return arr.filter((d: any) => d && typeof d.id === "string");
  } catch {
    return [];
  }
}

function salvar(arr: Disparo[]): void {
  gravarJsonAtomico(arquivo(), arr.slice(-LIMITE_DISPAROS));
}

/** Mais recentes primeiro. */
export function listarDisparos(): Disparo[] {
  return carregar().slice().reverse();
}

export function obterDisparo(id: string): Disparo | null {
  return carregar().find((d) => d.id === id) ?? null;
}

/** Mensagem final: texto + link opcional no fim. */
export function textoComLink(texto: string, link?: string | null): string {
  const t = String(texto ?? "").trim();
  const l = String(link ?? "").trim();
  if (!l) return t;
  return t ? `${t}\n\n${l}` : l;
}

export interface NovoDisparo {
  texto: string;
  link?: string | null;
  midia?: MidiaDisparo | null;
  listaId?: string | null;
  listaNome?: string | null;
  jids: string[];
  /** número que envia a campanha (null/ausente = Automático/rodízio) */
  instancia?: string | null;
}

export function criarDisparo(n: NovoDisparo): Disparo {
  const texto = String(n.texto ?? "").trim();
  const midia = n.midia ?? null;
  if (!texto && !midia) throw new Error("escreva a mensagem ou escolha uma mídia");
  const jids = [...new Set((n.jids ?? []).filter(Boolean))];
  if (!jids.length) throw new Error("a lista não tem contatos");
  const agora = new Date().toISOString();
  const d: Disparo = {
    id: randomUUID(),
    em: agora,
    atualizadoEm: agora,
    listaId: n.listaId ?? null,
    listaNome: n.listaNome ?? null,
    texto,
    link: String(n.link ?? "").trim() || null,
    midia,
    jids,
    total: jids.length,
    enviados: 0,
    falhas: 0,
    status: "PENDENTE",
    // número escolhido pelo operador (null = Automático/rodízio)
    instancia: String(n.instancia ?? "").trim() || null,
    erro: null,
  };
  const arr = carregar();
  arr.push(d);
  salvar(arr);
  return d;
}

export interface PatchDisparo {
  texto?: string;
  link?: string | null;
  midia?: MidiaDisparo | null;
  /** troca o número que envia a campanha (null = volta para Automático) */
  instancia?: string | null;
}

/**
 * Edita um disparo. Só é permitido enquanto NADA saiu (status PENDENTE):
 * depois disso, a operação correta é duplicar e reenviar.
 * Devolve o disparo atualizado ou lança erro explicando o motivo.
 */
export function editarDisparo(id: string, patch: PatchDisparo): Disparo {
  const arr = carregar();
  const d = arr.find((x) => x.id === id);
  if (!d) throw new Error("disparo não encontrado");
  if (d.status !== "PENDENTE" || d.enviados > 0 || d.falhas > 0) {
    throw new Error("só dá para editar disparo ainda não enviado — use duplicar para reenviar");
  }
  const texto = patch.texto !== undefined ? String(patch.texto).trim() : d.texto;
  const midia = patch.midia !== undefined ? patch.midia : d.midia;
  if (!texto && !midia) throw new Error("mensagem não pode ficar vazia sem mídia");
  d.texto = texto;
  if (patch.link !== undefined) d.link = String(patch.link ?? "").trim() || null;
  d.midia = midia;
  // troca do número remetente (issue #45) — só enquanto nada foi enviado
  if (patch.instancia !== undefined) d.instancia = String(patch.instancia ?? "").trim() || null;
  d.atualizadoEm = new Date().toISOString();
  salvar(arr);
  return d;
}

/** Remove o registro (o chamador cancela os itens da fila). */
export function excluirDisparo(id: string): boolean {
  const arr = carregar();
  const n = arr.length;
  const restante = arr.filter((d) => d.id !== id);
  if (restante.length === n) return false;
  salvar(restante);
  return true;
}

/** Cria uma cópia PENDENTE com os mesmos destinos (para reenviar). */
export function duplicarDisparo(id: string): Disparo {
  const arr = carregar();
  const d = arr.find((x) => x.id === id);
  if (!d) throw new Error("disparo não encontrado");
  const agora = new Date().toISOString();
  const copia: Disparo = {
    ...d,
    id: randomUUID(),
    em: agora,
    atualizadoEm: agora,
    enviados: 0,
    falhas: 0,
    status: "PENDENTE",
    erro: null,
  };
  arr.push(copia);
  salvar(arr);
  return copia;
}

/** Marca como CANCELADO (usado quando a fila é limpa ou o registro é excluído). */
export function cancelarDisparo(id: string, motivo = "cancelado pelo usuário"): Disparo | null {
  const arr = carregar();
  const d = arr.find((x) => x.id === id);
  if (!d) return null;
  if (d.status === "CONCLUIDO" || d.status === "PARCIAL" || d.status === "ERRO") return d;
  d.status = "CANCELADO";
  d.erro = motivo;
  d.atualizadoEm = new Date().toISOString();
  salvar(arr);
  return d;
}

/**
 * Registra o resultado de 1 contato. O status do disparo passa a refletir o
 * progresso: ENVIANDO enquanto sobra gente; CONCLUIDO/PARCIAL/ERRO no fim.
 */
export function registrarResultadoDisparo(
  id: string,
  ok: boolean,
  erro?: string | null,
): Disparo | null {
  const arr = carregar();
  const d = arr.find((x) => x.id === id);
  if (!d || d.status === "CANCELADO") return d ?? null;
  if (ok) d.enviados++;
  else {
    d.falhas++;
    if (erro) d.erro = String(erro).slice(0, 200);
  }
  const feitos = d.enviados + d.falhas;
  if (feitos >= d.total) {
    d.status = d.falhas === 0 ? "CONCLUIDO" : d.enviados === 0 ? "ERRO" : "PARCIAL";
  } else {
    d.status = "ENVIANDO";
  }
  d.atualizadoEm = new Date().toISOString();
  salvar(arr);
  return d;
}

export interface ResumoDisparos {
  total: number;
  pendentes: number;
  porStatus: Record<StatusDisparo, number>;
  enviados: number;
  falhas: number;
}

export function resumoDisparos(): ResumoDisparos {
  const arr = carregar();
  const porStatus = {
    PENDENTE: 0, ENVIANDO: 0, CONCLUIDO: 0, PARCIAL: 0, ERRO: 0, CANCELADO: 0,
  } as Record<StatusDisparo, number>;
  let enviados = 0;
  let falhas = 0;
  for (const d of arr) {
    porStatus[d.status] = (porStatus[d.status] ?? 0) + 1;
    enviados += Number(d.enviados ?? 0);
    falhas += Number(d.falhas ?? 0);
  }
  return { total: arr.length, pendentes: porStatus.PENDENTE, porStatus, enviados, falhas };
}
