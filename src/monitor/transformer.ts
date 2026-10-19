/**
 * Transformador de link de afiliado (E6 / RF-032 / RN-012).
 * Troca o link original pelo link de afiliado do usuário.
 * - Mercado Livre: reusa converterLink (provider.ts) com TAG/COOKIE já configurados.
 * - Shopee/KaBuM/Amazon: aplica parâmetro de rastreio quando configurado; senão mantém
 *   o link (marcando NAO_TRANSFORMADO para revisão, nunca inventa link).
 */
import { converterLink } from "../ml/provider.js";
import { resolverProdutoML, type DadosProduto } from "./produto.js";
import { extrairId, type LinkDetectado } from "./parser.js";
import { expandirCurtoAmazon } from "./curtos.js";
import { resolverProdutoAmazon } from "./amazon-api.js";

export interface ResultadoTransformacao {
  url: string;
  ok: boolean; // true = link de afiliado do usuário aplicado
  motivo?: string; // quando ok=false
  /** Dados reais do anúncio (título/foto) para montar o template anterior. */
  produto?: DadosProduto;
}

function comParam(url: string, chave: string, valor: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(chave, valor);
    return u.toString();
  } catch {
    return url;
  }
}

/** Normaliza título p/ comparação (sem acento, caixa baixa, espaços). */
function normalizarTitulo(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mesmo produto? (igualdade ou um contendo o outro, com tamanho útil). */
function mesmoTitulo(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const menor = a.length <= b.length ? a : b;
  const maior = a.length <= b.length ? b : a;
  return menor.length >= 20 && maior.includes(menor);
}

/** Mercado Livre: geração direta com tag+cookie (fonte única de verdade já testada). */
async function transformarML(link: LinkDetectado, conta?: string): Promise<ResultadoTransformacao> {
  // Link curto (meli.la/XXXX) não traz o MLB id → resolve o redirect p/ achar os
  // candidatos de id (createLink) e a foto do produto (template anterior).
  const produto = await resolverProdutoML(link.url);
  const alvoTitulo = normalizarTitulo(produto?.titulo);

  // A página traz vários MLB-<id> (catálogo/relacionados). Nem `wid=` nem
  // `item_id` são confiáveis sozinhos: só vale o id cujo link, resolvido de
  // volta, tem o MESMO título. Senão postaríamos foto de um produto e link de outro.
  const candidatos: string[] = [];
  const push = (v?: string | null) => {
    if (!v) return;
    const norm = `MLB-${String(v).replace(/^MLB-?/i, "")}`;
    if (!candidatos.includes(norm)) candidatos.push(norm);
  };
  push(link.idProduto);
  for (const id of produto?.ids ?? []) push(id);

  let ultimoAviso = "COOKIE_OU_CONVERSOR_FALHOU — link ML não transformado";
  let reserva: ResultadoTransformacao | null = null;
  for (const id of candidatos.slice(0, 6)) {
    const alvo = `https://produto.mercadolivre.com.br/${id}`;
    const r = await converterLink(alvo, { conta });
    if (!(r.fonte === "conversor" && /^https?:\/\//.test(r.linkAfiliado) && r.linkAfiliado !== alvo)) {
      if (r.aviso) ultimoAviso = r.aviso;
      continue;
    }
    // Título autoritativo = o do deal (página do link curto).
    const monta = (volta: typeof produto): DadosProduto => ({
      id,
      ids: produto?.ids ?? [id],
      titulo: produto?.titulo ?? volta?.titulo ?? null,
      imagem: volta?.imagem ?? produto?.imagem ?? null,
      urlFinal: alvo,
    });
    // Sem título de referência não há como validar → aceita o 1º que converteu.
    if (!alvoTitulo) return { url: r.linkAfiliado, ok: true, produto: monta(produto) };

    const volta = await resolverProdutoML(r.linkAfiliado);
    if (mesmoTitulo(alvoTitulo, normalizarTitulo(volta?.titulo))) {
      return { url: r.linkAfiliado, ok: true, produto: monta(volta) };
    }
    // guarda o 1º que converteu, mas segue tentando achar o produto certo
    if (!reserva) reserva = { url: r.linkAfiliado, ok: true, produto: monta(volta) };
  }
  if (reserva) return reserva;
  // Último recurso: a própria URL (quando já é um link de produto completo).
  if (!candidatos.length) {
    const r = await converterLink(link.url, { conta });
    if (r.fonte === "conversor" && /^https?:\/\//.test(r.linkAfiliado) && r.linkAfiliado !== link.url) {
      return { url: r.linkAfiliado, ok: true, produto: produto ?? undefined };
    }
    if (r.aviso) ultimoAviso = r.aviso;
  }
  return { url: link.url, ok: false, motivo: ultimoAviso, produto: produto ?? undefined };
}

export async function transformar(
  link: LinkDetectado,
  opts: { conta?: string } = {}
): Promise<ResultadoTransformacao> {
  switch (link.programa) {
    case "mercadolivre":
      return transformarML(link, opts.conta);

    case "amazon": {
      // Rastreio Amazon via tag de associado (AMAZON_TAG no .env).
      const tag = process.env.AMAZON_TAG?.trim();
      // Encurtadores (amzn.to/amzn.com.br) não repassam query params: resolve o
      // redirect ANTES de aplicar a tag, senão a comissão se perde no salto.
      let alvo = link.url;
      if (/^(www\.)?amzn\.(to|com\.br)$/i.test(link.host)) {
        const final = await expandirCurtoAmazon(link.url);
        if (final) alvo = final;
      }
      const asin = link.idProduto ?? extrairId(alvo, "amazon");
      const url = tag ? comParam(alvo, "tag", tag) : alvo;
      // Enriquecimento opcional (Creators API): título/foto p/ sair no template
      // completo (com foto), igual ao Mercado Livre. Sem credencial/falha na
      // API → segue como antes; nunca bloqueia o encaminhamento.
      let produto: DadosProduto | undefined;
      if (asin) {
        const dados = await resolverProdutoAmazon(asin);
        if (dados) {
          produto = {
            id: dados.asin,
            ids: [dados.asin],
            titulo: dados.titulo,
            imagem: dados.imagem,
            urlFinal: alvo,
          };
        }
      }
      if (tag) return { url, ok: true, produto };
      return { url: alvo, ok: false, motivo: "AMAZON_TAG não configurado", produto };
    }

    case "shopee": {
      // Shopee usa link próprio do painel de afiliado; sem geração automática confiável.
      // Aplica sub_id de rastreio se configurado, senão marca para revisão.
      const sub = process.env.SHOPEE_SUBID?.trim();
      if (sub) return { url: comParam(link.url, "smtt", sub), ok: true };
      return { url: link.url, ok: false, motivo: "SHOPEE_SUBID não configurado — revisar manualmente" };
    }

    case "kabum": {
      // KaBuM: parâmetro de tracking genérico quando configurado.
      const ref = process.env.KABUM_REF?.trim();
      if (ref) return { url: comParam(link.url, "utm_source", ref), ok: true };
      return { url: link.url, ok: false, motivo: "KABUM_REF não configurado — revisar manualmente" };
    }

    default:
      return { url: link.url, ok: false, motivo: "Programa não reconhecido" };
  }
}
