/** Testes do transformer — foco no case Shopee (Open API) e regressões simples. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformar } from "./transformer.js";
import { limparCacheShopee } from "./shopee-api.js";
import { mockFetch, resJson } from "./test-utils.js";
import type { LinkDetectado } from "./parser.js";

const SHOPEE: LinkDetectado = {
  url: "https://shopee.com.br/product/1/2",
  host: "shopee.com.br",
  programa: "shopee",
  idProduto: "1.2",
};

function limparEnv(): void {
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_APP_SECRET;
  delete process.env.SHOPEE_SUB_IDS;
  delete process.env.SHOPEE_SUBID;
  delete process.env.KABUM_REF;
  limparCacheShopee();
}

function comCredenciais(): void {
  process.env.SHOPEE_APP_ID = "app-1";
  process.env.SHOPEE_APP_SECRET = "secret-1";
}

test("Shopee com Open API: ok=true e URL é o shortLink", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () =>
    resJson({ data: { generateShortLink: { shortLink: "https://shope.ee/abc123" } } }),
  );
  try {
    const r = await transformar(SHOPEE);
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://shope.ee/abc123");
    assert.equal(m.chamadas.length, 1);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("Shopee com Open API falhando: ok=false, link original e revisão", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () => resJson({ message: "erro" }, 500));
  try {
    const r = await transformar(SHOPEE);
    assert.equal(r.ok, false);
    assert.equal(r.url, SHOPEE.url);
    assert.match(r.motivo ?? "", /Open API falhou/);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("Shopee sem credenciais: ok=false e não toca na rede", async () => {
  limparEnv();
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await transformar(SHOPEE);
    assert.equal(r.ok, false);
    assert.equal(r.url, SHOPEE.url);
    assert.match(r.motivo ?? "", /SHOPEE_APP_ID/);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("SHOPEE_SUBID legado: aplica smtt, mas ok=false (não é afiliado)", async () => {
  limparEnv();
  process.env.SHOPEE_SUBID = "promo1";
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await transformar(SHOPEE);
    assert.equal(r.ok, false);
    assert.match(r.url, /[?&]smtt=promo1/);
    assert.match(r.motivo ?? "", /smtt/);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("KaBuM segue funcionando com KABUM_REF", async () => {
  limparEnv();
  process.env.KABUM_REF = "canal";
  try {
    const r = await transformar({
      url: "https://www.kabum.com.br/produto/123/teste",
      host: "kabum.com.br",
      programa: "kabum",
      idProduto: "123",
    });
    assert.equal(r.ok, true);
    assert.match(r.url, /[?&]utm_source=canal/);
  } finally {
    limparEnv();
  }
});
