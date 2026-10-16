import type { Oportunidade } from "../hunter/schema.js";

export interface MensagemInput {
  headline: string;
  subtitulo: string;
  nome: string;
  precoDe: number | null;
  precoPix: number;
  precoParc?: number;
  parcelas?: number;
  cupom?: string | null;
  link: string;
  categoria: string;
  score: number;
  /** Marca no topo (ex. "@radar  Radar  #anúncio"); default: env ou omitida. */
  marca?: string | null;
  /** Linha ℹ️ do Pix (default: omitida). */
  infoPix?: string | null;
  /** Linha 🚚 do frete (default: omitida; nunca inventar). */
  frete?: string | null;
}

export const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** R$ 1.066 / R$ 449 quando inteiro; R$ 233,53 quando quebrado. */
export const brlCurto = (v: number): string =>
  Number.isInteger(v)
    ? `R$ ${v.toLocaleString("pt-BR")}`
    : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function marcaPadrao(): string | null {
  const handle = process.env.MARCA_HANDLE?.trim();
  const nome = process.env.MARCA_NOME?.trim();
  if (!handle && !nome) return null;
  return [handle, nome, "#anúncio"].filter(Boolean).join("  ");
}

/**
 * Template RN-001 v3 — modelo COMPLETO (volta ao v1 com as informações):
 * foto + título 🔥 + preços De/Por/parcelas + cupom + link.
 * Sem negrito forçado, sem rodapé 🤖 (removido a pedido).
 */
export function formatar(o: MensagemInput): string {
  const marca = o.marca !== undefined ? o.marca : marcaPadrao();
  const parc = o.precoParc ?? +(o.precoPix * 1.11).toFixed(2);
  const n = o.parcelas ?? 6;
  const linhas = [
    ...(marca ? [marca, ``] : []),
    `🔥 ${o.nome}`,
    ``,
    ...(o.infoPix ? [`ℹ️ ${o.infoPix}`, ``] : []),
    ...(o.precoDe ? [`~De ${brl(o.precoDe)}~`] : []),
    `*Por ${brl(o.precoPix)} no Pix*`,
    `*Ou ${brl(parc)} em até ${n}x*`,
    ``,
    ...(o.frete ? [`🚚 ${o.frete}`, ``] : []),
    ...(o.cupom ? [`🎟️ Cupom: *${o.cupom.toUpperCase()}*`, ``] : []),
    `🛒 Link do Produto ⤵️`,
    o.link,
  ];
  const txt = linhas.join("\n");
  if (txt.length > 4096) throw new Error("MENSAGEM_LONGA");
  return txt;
}

export function headlinePara(o: Oportunidade, categoria: string): MensagemInput {
  const marca = o.titulo.split(" ").slice(0, 3).join(" ").toUpperCase();
  return {
    headline: `${marca} — QUALIDADE ABSURDA`,
    subtitulo: "caiu muito o preço",
    nome: o.titulo,
    precoDe: o.precoDe,
    precoPix: o.precoAtual,
    cupom: o.cupom,
    link: o.link,
    categoria,
    score: o.score,
  };
}
