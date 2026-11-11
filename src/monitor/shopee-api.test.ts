/** Testes do client Shopee Open API — fetch mockado, sem rede real. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assinaturaShopee,
  gerarLinkShopee,
  limparCacheShopee,
  subIdsShopee,
} from "./shopee-api.js";
import { mockFetch, resJson } from "./test-utils.js";

const URL_PRODUTO = "https://shopee.com.br/product/1/2";

function limparEnv(): void {
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_APP_SECRET;
  delete process.env.SHOPEE_SUB_IDS;
  delete process.env.SHOPEE_SUBID;
  limparCacheShopee();
}

function comCredenciais(): void {
  process.env.SHOPEE_APP_ID = "app-1";
  process.env.SHOPEE_APP_SECRET = "secret-1";
}

test("assinatura: SHA256(AppId+Timestamp+Payload+Secret)", () => {
  const payload = JSON.stringify({
    query:
      'mutation { generateShortLink(input: { originUrl: "https://shopee.com.br/product/1/2", subIds: ["a","b"] }) { shortLink } }',
  });
  assert.equal(
    assinaturaShopee("123456", "1704067200", payload, "secret"),
    "81299ac47f1a64992839d364aca4a9bb8832a43c234bb5f465da883eab502e42",
  );
});

test("sem credenciais: null sem tocar na rede", async () => {
  limparEnv();
  const m = mockFetch(async () => resJson({}));
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), null);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
  }
});

test("fluxo feliz: assina o payload e devolve o shortLink", async () => {
  limparEnv();
  comCredenciais();
  process.env.SHOPEE_SUB_IDS = "whatsapp, grupo_ofertas";
  let corpo = "";
  const m = mockFetch(async (url, init) => {
    assert.equal(url, "https://open-api.affiliate.shopee.com.br/graphql");
    corpo = String(init?.body);
    const auth = (init?.headers as Record<string, string>).authorization;
    const partes = auth.match(/^SHA256 Credential=app-1, Timestamp=(\d+), Signature=([a-f0-9]{64})$/);
    assert.ok(partes, `header inesperado: ${auth}`);
    assert.equal(partes[2], assinaturaShopee("app-1", partes[1], corpo, "secret-1"));
    return resJson({
      data: { generateShortLink: { shortLink: "https://shope.ee/abc123xyz" } },
    });
  });
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), "https://shope.ee/abc123xyz");
    const query = (JSON.parse(corpo) as { query: string }).query;
    assert.match(query, /originUrl: "https:\/\/shopee\.com\.br\/product\/1\/2"/);
    assert.match(query, /subIds: \["whatsapp","grupo_ofertas"\]/);
    assert.equal(m.chamadas.length, 1);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("cache: mesma origem + subIds reusa o resultado", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () =>
    resJson({ data: { generateShortLink: { shortLink: "https://shope.ee/cacheado" } } }),
  );
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), "https://shope.ee/cacheado");
    assert.equal(await gerarLinkShopee(URL_PRODUTO), "https://shope.ee/cacheado");
    assert.equal(m.chamadas.length, 1);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("subIds: lista com vírgula, trim e limite de 5", () => {
  limparEnv();
  process.env.SHOPEE_SUB_IDS = " s1, s2 ,s3,s4,s5,s6,s7 ";
  assert.deepEqual(subIdsShopee(), ["s1", "s2", "s3", "s4", "s5"]);
  delete process.env.SHOPEE_SUB_IDS;
  process.env.SHOPEE_SUBID = "legado";
  assert.deepEqual(subIdsShopee(), ["legado"]);
  limparEnv();
});

test("5 subIds no máximo vão no payload", async () => {
  limparEnv();
  comCredenciais();
  process.env.SHOPEE_SUB_IDS = "s1,s2,s3,s4,s5,s6,s7";
  let corpo = "";
  const m = mockFetch(async (_url, init) => {
    corpo = String(init?.body);
    return resJson({ data: { generateShortLink: { shortLink: "https://shope.ee/x" } } });
  });
  try {
    await gerarLinkShopee(URL_PRODUTO);
    const query = (JSON.parse(corpo) as { query: string }).query;
    assert.match(query, /subIds: \["s1","s2","s3","s4","s5"\]/);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("HTTP não-OK: null e não grava cache", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () => resJson({ message: "rate limit" }, 429));
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), null);
    assert.equal(await gerarLinkShopee(URL_PRODUTO), null);
    assert.equal(m.chamadas.length, 2);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("erro GraphQL: null", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () => resJson({ errors: [{ message: "invalid signature" }] }));
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), null);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("shortLink fora dos domínios Shopee: null (não aceita redirect arbitrário)", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () =>
    resJson({ data: { generateShortLink: { shortLink: "https://evil.example/x" } } }),
  );
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), null);
  } finally {
    m.restaurar();
    limparEnv();
  }
});

test("fetch lança (timeout/rede): null", async () => {
  limparEnv();
  comCredenciais();
  const m = mockFetch(async () => {
    throw new Error("timeout");
  });
  try {
    assert.equal(await gerarLinkShopee(URL_PRODUTO), null);
  } finally {
    m.restaurar();
    limparEnv();
  }
});
