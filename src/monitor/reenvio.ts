/**
 * REENVIO a partir do catálogo (ADR-012, Fase 3).
 *
 * Por que é um módulo e não código dentro do `server.ts`: a regra "o lote nunca
 * aceita o que o individual recusa" precisa de teste unitário. O servidor só
 * valida o corpo HTTP e delega para cá.
 *
 * Semântica:
 * - o reenvio vai para a MESMA fila do Monitor (respeita o intervalo anti-rajada);
 * - `reenvioManual: true` ignora a trava de duplicata — o operador pediu de
 *   propósito, e pedir duas vezes é uma escolha dele, não um bug;
 * - um item inválido no lote não derruba os outros: devolve o que entrou e o
 *   motivo de cada recusa.
 */
import { obterOferta, type OfertaRecebida } from "../store/catalogo.js";
import { carregarMonitor, destinosPara } from "./grupos.js";
import { enfileirar, tamanhoFila, type ItemFila } from "./fila.js";
import { randomUUID } from "node:crypto";

/** Teto por chamada: acima disso o operador divide a seleção. */
export const MAX_REENVIO_LOTE = 100;

export type ValidacaoReenvio =
  | { ok: true; oferta: OfertaRecebida; destinos: string[] }
  | { ok: false; status: number; erro: string };

/** Valida uma oferta do catálogo para reenvio (usado pelo individual e pelo lote). */
export function validarReenvio(oferta: OfertaRecebida | null): ValidacaoReenvio {
  if (!oferta) return { ok: false, status: 404, erro: "oferta não encontrada no catálogo" };
  if (!oferta.mensagem) {
    return {
      ok: false,
      status: 409,
      erro: "esta oferta foi descartada antes da formatação — não há mensagem para reenviar",
    };
  }
  if (!carregarMonitor().autoEnviar) {
    return {
      ok: false,
      status: 409,
      erro: "envio direto do Monitor está desligado — ligue para liberar o reenvio",
    };
  }
  const destinos = destinosPara(oferta.origem).map((d) => d.jid);
  if (!destinos.length) {
    return { ok: false, status: 409, erro: "a origem desta oferta não tem grupo de destino configurado" };
  }
  return { ok: true, oferta, destinos };
}

/** Enfileira a oferta validada no Monitor (mesmo caminho do envio normal). */
export function enfileirarReenvio(oferta: OfertaRecebida, destinos: string[]): ItemFila {
  return enfileirar({
    origem: oferta.origem,
    programa: oferta.programa ?? "desconhecido",
    idProduto: oferta.idProduto,
    link: oferta.link ?? "",
    mensagem: oferta.mensagem ?? "",
    titulo: oferta.titulo,
    imagem: oferta.imagem ?? "",
    destinos,
    reenvioManual: true,
    correlationId: randomUUID(),
  });
}

export type ResultadoIndividual =
  | { ok: true; item: ItemFila; destinos: string[]; fila: number }
  | { ok: false; status: number; erro: string };

/** Reenvio de UMA oferta por id. */
export function reenviarOferta(id: string): ResultadoIndividual {
  const v = validarReenvio(obterOferta(id));
  if (!v.ok) return { ok: false, status: v.status, erro: v.erro };
  const item = enfileirarReenvio(v.oferta, v.destinos);
  return { ok: true, item, destinos: v.destinos, fila: tamanhoFila() };
}

export interface ResultadoLote {
  enfileiradas: number;
  ignoradas: { id: string; motivo: string }[];
  fila: number;
}

/** Normaliza a seleção vinda do painel: só strings, sem vazios, sem repetição. */
export function normalizarIds(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  const limpos = bruto
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return [...new Set(limpos)];
}

/** Reenvio em lote: item a item, acumulando recusas em vez de abortar tudo. */
export function reenviarLote(ids: string[]): ResultadoLote {
  const ignoradas: { id: string; motivo: string }[] = [];
  let enfileiradas = 0;
  for (const id of ids) {
    const v = validarReenvio(obterOferta(id));
    if (!v.ok) {
      ignoradas.push({ id, motivo: v.erro });
      continue;
    }
    try {
      enfileirarReenvio(v.oferta, v.destinos);
      enfileiradas++;
    } catch (e) {
      ignoradas.push({ id, motivo: e instanceof Error ? e.message : String(e) });
    }
  }
  return { enfileiradas, ignoradas, fila: tamanhoFila() };
}
