/** Testes do cliente de favoritos do Mercado Livre (inerte sem token). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { favoritarItem, favoritosHabilitados, listarFavoritos, chaveItem } from "./favoritos.js";
import { mockFetch, resJson } from "../monitor/test-utils.js";

test("sem ML_ACCESS_TOKEN: módulo inerte, nenhuma chamada de rede", async () => {
  delete process.env.ML_ACCESS_TOKEN;
  assert.equal(favoritosHabilitados(), false);
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await favoritarItem("MLB123456789");
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /ML_ACCESS_TOKEN/);
    assert.equal(m.chamadas.length, 0);
    assert.equal(await listarFavoritos(), null);
  } finally {
    m.restaurar();
  }
});

test("com token: POST /users/me/bookmarks com o item_id", async () => {
  process.env.ML_ACCESS_TOKEN = "token-teste";
  let url = "";
  let corpo = "";
  let auth = "";
  const m = mockFetch(async (u, init) => {
    url = u;
    corpo = String(init?.body);
    auth = String((init?.headers as Record<string, string>).Authorization);
    return resJson({ item_id: "MLB123456789" });
  });
  try {
    const r = await favoritarItem("MLB123456789");
    assert.equal(r.ok, true);
    assert.match(url, /api\.mercadolibre\.com\/users\/me\/bookmarks$/);
    assert.equal(auth, "Bearer token-teste");
    assert.deepEqual(JSON.parse(corpo), { item_id: "MLB123456789" });
  } finally {
    m.restaurar();
    delete process.env.ML_ACCESS_TOKEN;
  }
});

test("item_id inválido é recusado antes da rede", async () => {
  process.env.ML_ACCESS_TOKEN = "token-teste";
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await favoritarItem("nao-e-item");
    assert.equal(r.ok, false);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
    delete process.env.ML_ACCESS_TOKEN;
  }
});

test("erro da API não derruba o fluxo (devolve erro, não lança)", async () => {
  process.env.ML_ACCESS_TOKEN = "token-teste";
  const m = mockFetch(async () => resJson({ message: "forbidden" }, 403));
  try {
    const r = await favoritarItem("MLB123456789");
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /403/);
  } finally {
    m.restaurar();
    delete process.env.ML_ACCESS_TOKEN;
  }
});

test("chaveItem: determinística por item", () => {
  assert.equal(chaveItem("MLB123"), chaveItem("mlb123"));
  assert.notEqual(chaveItem("MLB123"), chaveItem("MLB456"));
});
