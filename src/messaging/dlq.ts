/**
 * DLQ — Dead Letter Queue (fila de mensagens mortas).
 *
 * Mensagem que falhou de forma definitiva (erro não transitório) ou que
 * esgotou as tentativas vai para cá **com o motivo** — nunca para o lixo.
 * A DLQ não bloqueia o fluxo: a fila segue processando os próximos itens.
 *
 * Itens na DLQ **não voltam sozinhos**: só por ação explícita do operador
 * (endpoint de reprocessamento).
 *
 * Retenção: default 1000 itens por tipo (o mais antigo sai).
 */
import { existsSync, readdirSync } from "node:fs";
import { gravarJsonAtomico, lerJson } from "../store/json.js";
import { caminhoDlq, dirMensageria, nomeSeguro } from "./caminhos.js";
import type { Envelope } from "./envelope.js";

export interface ItemDLQ {
  /** id do envelope (o mesmo da mensagem) */
  id: string;
  /** tipo da mensagem ("cliente.enviar", "monitor.encaminhar", ...) */
  tipo: string;
  /** envelope completo (estado da mensagem no momento da morte) */
  envelope: Envelope;
  /** motivo canônico ("erro não transitório", "tentativas esgotadas") */
  motivo: string;
  /** última mensagem de erro registrada */
  ultimoErro: string;
  /** nº de tentativas feitas */
  tentativas: number;
  /** ISO da última tentativa */
  ultimaTentativaEm: string;
  /** origem (disparo/lista/fluxo) */
  origem: string | null;
}

/** Limite de retenção da DLQ por tipo (o mais antigo sai). */
export function limiteDlq(): number {
  const n = Number(process.env.MENSAGERIA_DLQ_LIMITE ?? 1000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

/** Itens da DLQ de um tipo. */
export function lerDlq(tipo: string): ItemDLQ[] {
  const raw = lerJson<any>(caminhoDlq(tipo), []);
  return Array.isArray(raw) ? (raw as ItemDLQ[]) : [];
}

/** Grava a DLQ de um tipo aplicando a retenção. */
export function gravarDlq(tipo: string, itens: ItemDLQ[]): void {
  const limite = limiteDlq();
  const guardados = itens.slice(Math.max(0, itens.length - limite));
  gravarJsonAtomico(caminhoDlq(tipo), guardados);
}

/** Registra um item na DLQ do tipo (com retenção). */
export function registrarDlq(item: ItemDLQ): void {
  const itens = lerDlq(item.tipo);
  itens.push(item);
  gravarDlq(item.tipo, itens);
}

/** Tipos que possuem DLQ no diretório de mensageria. */
export function tiposComDlq(): string[] {
  try {
    if (!existsSync(dirMensageria())) return [];
    return readdirSync(dirMensageria())
      .filter((f) => f.startsWith("dlq-") && f.endsWith(".json"))
      .map((f) => nomeSeguro(f.slice("dlq-".length, -".json".length)));
  } catch {
    return [];
  }
}

/** Remove um item da DLQ pelo id (procura em todos os tipos). */
export function removerDlq(id: string): ItemDLQ | null {
  for (const tipo of tiposComDlq()) {
    const itens = lerDlq(tipo);
    const item = itens.find((i) => i.id === id);
    if (!item) continue;
    gravarDlq(
      tipo,
      itens.filter((i) => i.id !== id)
    );
    return item;
  }
  return null;
}
