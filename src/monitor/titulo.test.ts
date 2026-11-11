import { test } from "node:test";
import assert from "node:assert/strict";
import { extrairTitulo, limparLinha } from "./titulo.js";

test("título do corpo repassado (template 🔥 título - preço)", () => {
  const msg = [
    "🔥 Ômega 3 EPA DHA Dark Lab em cápsula Sem sabor de 120 un - R$ 58,40",
    "",
    "~De R$ 229,90~",
    "*Por R$ 58,40 no Pix*",
    "*Ou R$ 64,82 em até 6x*",
    "",
    "🛒 Link do Produto ⤵️",
    "https://meli.la/2YH7zDk",
  ].join("\n");
  assert.equal(
    extrairTitulo(msg),
    "Ômega 3 EPA DHA Dark Lab em cápsula Sem sabor de 120 un"
  );
});

test("título sem preço na linha", () => {
  const msg = "Tênis Fila Masculino Spry Esportivo Treino Corrida Academia Marinho/branco/vermelho Mesh 39\n\nDe R$ 399,00";
  assert.equal(
    extrairTitulo(msg),
    "Tênis Fila Masculino Spry Esportivo Treino Corrida Academia Marinho/branco/vermelho Mesh 39"
  );
});

test("ignora linhas de preço, CTA e código puro", () => {
  assert.equal(extrairTitulo("R$ 19,90\nPor R$ 9,90 no Pix\nLink do Produto\nhttps://s.shopee.com.br/abc"), null);
  assert.equal(extrairTitulo("MLB5864818802"), null);
});

test("texto vazio/nulo", () => {
  assert.equal(extrairTitulo(""), null);
  assert.equal(extrairTitulo(null), null);
  assert.equal(extrairTitulo(undefined), null);
});

test("limita títulos muito longos a 120 caracteres", () => {
  const longo = "Fone de ouvido bluetooth " + "muito ".repeat(30) + "bom";
  const t = extrairTitulo(longo);
  assert.ok(t && t.length <= 120, `tamanho obtido: ${t?.length}`);
  assert.ok(t!.endsWith("…"));
});

test("limparLinha remove url, markdown e emoji", () => {
  assert.equal(limparLinha("🔥 *Cafeteira* https://x.y/z ✅"), "Cafeteira");
});
