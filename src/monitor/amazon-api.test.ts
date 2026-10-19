/** Testes do client Creators API (amazon-api.ts) — fetch mockado, sem rede real. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { limparCacheAmazon, resolverProdutoAmazon } from "./amazon-api.js";
import { mockFetch, resJson } from "./test-utils.js";

function comCredenciais(): void {
  process.env.AMAZON_CREATORS_ID = "cid-teste";
  process.env.AMAZON_CREATORS_SECRET = "sec-teste";
  process.env.AMAZON_TAG = "manodosachadi-20";
  limparCacheAmazon();
}

test("sem credenciais: null sem tocar na rede", async () => {
  delete process.env.AMAZON_CREATORS_ID;
  delete process.env.AMAZON_CREATORS_SECRET;
  limparCacheAmazon();
  const m = mockFetch(async () => resJson({}));
  try {
    assert.equal(await resolverProdutoAmazon("B0DWGWN8GY"), null);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
  }
});

test("fluxo feliz: token + getItems → título/imagem", async () => {
  comCredenciais();
  const m = mockFetch(async (url) => {
    if (url.includes("auth/o2/token")) return resJson({ access_token: "tok-1", expires_in: 3600 });
    return resJson({
      itemsResult: {
        items: [
          {
            asin: "B0DWGWN8GY",
            detailPageURL: "https://www.amazon.com.br/dp/B0DWGWN8GY?tag=manodosachadi-20",
            images: { primary: { large: { url: "https://m.media-amazon.com/images/I/x.jpg" } } },
            itemInfo: { title: { displayValue: "Processador AMD Ryzen 9 9900X3D" } },
          },
        ],
      },
    });
  });
  try {
    const d = await resolverProdutoAmazon("b0dwgwn8gy"); // minúsculo → normaliza
    assert.equal(d?.asin, "B0DWGWN8GY");
    assert.equal(d?.titulo, "Processador AMD Ryzen 9 9900X3D");
    assert.equal(d?.imagem, "https://m.media-amazon.com/images/I/x.jpg");
    assert.equal(m.chamadas.filter((u) => u.includes("auth/o2/token")).length, 1);
    assert.equal(m.chamadas.filter((u) => u.includes("/catalog/v1/getItems")).length, 1);
  } finally {
    m.restaurar();
  }
});

test("cache: 2ª consulta reusa o token (1 só fetch de token)", async () => {
  comCredenciais();
  const m = mockFetch(async (url) => {
    if (url.includes("auth/o2/token")) return resJson({ access_token: "tok-1", expires_in: 3600 });
    return resJson({
      itemsResult: { items: [{ asin: "B0DWGWN8GY", itemInfo: { title: { displayValue: "X" } } }] },
    });
  });
  try {
    await resolverProdutoAmazon("B0DWGWN8GY");
    await resolverProdutoAmazon("B0WFSBQBNK");
    assert.equal(m.chamadas.filter((u) => u.includes("auth/o2/token")).length, 1);
  } finally {
    m.restaurar();
  }
});

test("401 no getItems: renova o token e tenta mais 1x", async () => {
  comCredenciais();
  let getItems = 0;
  const m = mockFetch(async (url) => {
    if (url.includes("auth/o2/token")) return resJson({ access_token: `tok-${getItems}`, expires_in: 3600 });
    getItems++;
    if (getItems === 1) return resJson({ message: "unauthorized" }, 401);
    return resJson({
      itemsResult: { items: [{ asin: "B0DWGWN8GY", itemInfo: { title: { displayValue: "Y" } } }] },
    });
  });
  try {
    const d = await resolverProdutoAmazon("B0DWGWN8GY");
    assert.equal(d?.titulo, "Y");
    assert.equal(m.chamadas.filter((u) => u.includes("auth/o2/token")).length, 2);
  } finally {
    m.restaurar();
  }
});
