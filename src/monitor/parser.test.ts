/**
 * Testes do parser (primeiros testes automatizados do projeto — auditoria P0).
 * Puros: sem rede, sem estado global. `npm run build && npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectar, classificar, extrairId, limparTexto } from "./parser.js";

test("classificar: hosts da allowlist por programa", () => {
  assert.equal(classificar("https://meli.la/13WnKvX").programa, "mercadolivre");
  assert.equal(classificar("https://produto.mercadolivre.com.br/MLB-123-x").programa, "mercadolivre");
  assert.equal(classificar("https://www.amazon.com.br/dp/B0DWGWN8GY").programa, "amazon");
  assert.equal(classificar("https://amzn.to/abc").programa, "amazon");
  assert.equal(classificar("https://s.shopee.com.br/abc").programa, "shopee");
  assert.equal(classificar("https://www.kabum.com.br/produto/123-x").programa, "kabum");
});

test("classificar: domínio de redirecionador da origem cai como desconhecido", () => {
  // caso real do bug #55 (Epipe): expansão é feita no webhook via curtos.ts
  assert.equal(classificar("https://oferta.emipefps.com/amazon/cpxhU6").programa, "desconhecido");
});

test("detectar: acha o principal, extrai id e limpa o texto", () => {
  const o = detectar("🔥 Oferta\n👉 https://meli.la/13WnKvX\ncorre!");
  assert.equal(o.principal?.programa, "mercadolivre");
  assert.equal(o.principal?.url, "https://meli.la/13WnKvX");
  assert.ok(!o.textoLimpo.includes("meli.la"));
  assert.ok(o.textoLimpo.includes("Oferta"));
});

test("detectar: sem link reconhecido → principal null e texto intacto", () => {
  const t = "manda esse https://oferta.emipefps.com/amazon/cpxhU6";
  const o = detectar(t);
  assert.equal(o.principal, null);
  assert.equal(o.textoLimpo, t);
});

test("limparTexto: remove a URL e a linha decorativa órfã", () => {
  assert.equal(limparTexto("Oferta top\n👉 https://meli.la/x\n😂😂", "https://meli.la/x"), "Oferta top");
});

test("extrairId: ML, Amazon e Shopee", () => {
  assert.equal(extrairId("https://produto.mercadolivre.com.br/MLB-1234567899-x", "mercadolivre"), "MLB1234567899");
  assert.equal(extrairId("https://www.amazon.com.br/dp/B0DWGWN8GY?tag=x-20", "amazon"), "B0DWGWN8GY");
  assert.equal(extrairId("https://shopee.com.br/product/123/456", "shopee"), "123.456");
});
