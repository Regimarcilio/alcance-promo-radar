/**
 * CAMINHOS da camada de Mensageria.
 *
 * Centraliza onde ficam as filas, as DLQs e os contadores para que broker,
 * DLQ e consumidores compartilhem exatamente o mesmo caminho (e o mesmo
 * arquivo `0600`).
 */
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";

/** Diretório base das filas: <data>/messaging. */
export function dirMensageria(): string {
  return join(dataDirAtual(), "messaging");
}

/** Nome de arquivo seguro para um tipo de mensagem. */
export function nomeSeguro(tipo: string): string {
  return String(tipo ?? "desconhecido").replace(/[^A-Za-z0-9._-]/g, "_") || "desconhecido";
}

/** Fila: <data>/messaging/<tipo>.json (array de envelopes). */
export function caminhoFila(tipo: string): string {
  return join(dirMensageria(), `${nomeSeguro(tipo)}.json`);
}

/** DLQ: <data>/messaging/dlq-<tipo>.json (array de itens com motivo). */
export function caminhoDlq(tipo: string): string {
  return join(dirMensageria(), `dlq-${nomeSeguro(tipo)}.json`);
}

/** Contadores: <data>/messaging/stats-<tipo>.json. */
export function caminhoStats(tipo: string): string {
  return join(dirMensageria(), `stats-${nomeSeguro(tipo)}.json`);
}
