/** Testes do módulo Amazon: categorias, link de afiliado e tag de rastreio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIAS_AMAZON,
  categoriaAmazon,
  keywordsDaCategoria,
  linkAfiliadoAmazon,
  tagAmazon,
} from "./amazon.js";

test("categorias Amazon: lista com id, nome e palavras de busca", () => {
  assert.ok(CATEGORIAS_AMAZON.length >= 10, "esperava ao menos 10 categorias");
  for (const c of CATEGORIAS_AMAZON) {
    assert.match(c.id, /^AM[A-Z0-9]+$/, `id inválido: ${c.id}`);
    assert.ok(c.nome.length > 2, `nome curto: ${c.nome}`);
    assert.ok(c.keywords.length > 0, `categoria sem palavras: ${c.id}`);
  }
});

test("categoriaAmazon: encontra por id e devolve null para id desconhecido", () => {
  const primeira = CATEGORIAS_AMAZON[0];
  assert.equal(categoriaAmazon(primeira.id)?.nome, primeira.nome);
  assert.equal(categoriaAmazon("NAO_EXISTE"), null);
});

test("linkAfiliadoAmazon: monta URL com a tag de comissão", () => {
  assert.equal(
    linkAfiliadoAmazon("B0DWGWN8GY", "meucanal-20"),
    "https://www.amazon.com.br/dp/B0DWGWN8GY?tag=meucanal-20",
  );
  // sem tag: link de vitrine (não paga comissão)
  assert.equal(linkAfiliadoAmazon("B0DWGWN8GY", ""), "https://www.amazon.com.br/dp/B0DWGWN8GY");
  // ASIN inválido
  assert.equal(linkAfiliadoAmazon("abc", "tag"), "");
});

test("tagAmazon: usa a tag da categoria (AMAZON_TAG_AMXXX) ou a global", () => {
  process.env.AMAZON_TAG = "global-20";
  process.env.AMAZON_TAG_AMJOIA = "joias-20";
  const id = CATEGORIAS_AMAZON[0].id;
  assert.equal(tagAmazon(id), "global-20");
  process.env[`AMAZON_TAG_${id}`] = "cat-20";
  assert.equal(tagAmazon(id), "cat-20");
  delete process.env[`AMAZON_TAG_${id}`];
  delete process.env.AMAZON_TAG;
  assert.equal(tagAmazon(id), "");
});

test("keywordsDaCategoria: rotaciona as palavras entre os giros", () => {
  const c = CATEGORIAS_AMAZON[0];
  const k0 = keywordsDaCategoria(c.id, 0);
  const k1 = keywordsDaCategoria(c.id, 1);
  assert.equal(k0.length, c.keywords.length);
  assert.notEqual(k0[0], k1[0], "giros diferentes devem buscar palavras diferentes");
  assert.deepEqual([...k0].sort(), [...c.keywords].sort());
});
