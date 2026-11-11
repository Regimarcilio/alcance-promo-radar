/**
 * Título legível da oferta postada (para o RASTREIO).
 *
 * Por que existe: o piloto grava o título do produto em `publicacoes.json`; o
 * monitor gravava vazio e a aba Rastreio só mostrava o código (MLB...). Aqui
 * extraímos o título de duas fontes, na ordem:
 *   1. `og:title` do anúncio (vem de `DadosProduto.titulo`, quando o
 *      transformador resolve o link);
 *   2. heurística sobre o texto publicado na origem (a 1ª linha "útil").
 *
 * A heurística não adivinha: só ignora ruído previsível (preço, parcelamento,
 * CTA, código puro) e devolve `null` quando não há nada confiável — quem chama
 * mantém o código como fallback.
 */

const RE_URL = /https?:\/\/\S+/gi;
const RE_MD = /[*_~`]+/g;
/** Emojis/pictogramas (inclui ZWJ e seletor de variação). */
const RE_EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
/** Preço no fim da linha: " - R$ 58,40", "R$ 197,99", "por R$ 10". */
const RE_PRECO_FIM = /\s*[-–—:]?\s*(?:de|por)?\s*R\$\s*\d[\d.,]*(?:\s*(?:no|em|à|a)\s*vista)?.*$/i;
/** Linhas que nunca são título. */
const RE_RUIDO =
  /^(de|por|ou|link|cupom|frete|compre|comprar|corre|aproveit|promo[cç][aã]o|oferta|desconto|pre[cç]o|parcel|pix|r\$|categoria|estoque)/i;

export function limparLinha(s: string): string {
  return s
    .replace(RE_URL, " ")
    .replace(RE_MD, "")
    .replace(RE_EMOJI, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai o título do texto de uma oferta (mensagem do grupo de origem ou corpo
 * já montado do repasse). Retorna `null` se não houver linha confiável.
 */
export function extrairTitulo(texto: string | null | undefined): string | null {
  if (!texto) return null;
  let melhor = "";
  for (const bruta of texto.split(/\r?\n/)) {
    let linha = limparLinha(bruta).replace(RE_PRECO_FIM, "").trim();
    if (linha.length < 8) continue;
    if (RE_RUIDO.test(linha)) continue;
    if (/^[A-Z0-9]{6,}$/i.test(linha)) continue; // código puro (MLB123…)
    const letras = (linha.match(/\p{L}/gu) ?? []).length;
    const digitos = (linha.match(/\d/g) ?? []).length;
    if (letras < 4 || digitos > letras * 1.5) continue; // linha numérica
    if (linha.length > melhor.length) melhor = linha;
  }
  if (!melhor) return null;
  return melhor.length > 120 ? melhor.slice(0, 117).trimEnd() + "…" : melhor;
}
