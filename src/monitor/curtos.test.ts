/** Testes da expansão de encurtadores Amazon (curtos.ts) — fetch mockado. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandirCurtoAmazon } from "./curtos.js";
import { mockFetch, resJson, resRedirect } from "./test-utils.js";

test("amzn.to: segue o 301 até o produto e devolve a URL final", async () => {
  const m = mockFetch(async (_url, init) => {
    if (init?.method === "HEAD") return resRedirect("https://www.amazon.com.br/dp/B0DWGWN8GY?th=1&psc=1");
    return resJson({});
  });
  try {
    const final = await expandirCurtoAmazon("https://amzn.to/3XYZabc");
    assert.equal(final, "https://www.amazon.com.br/dp/B0DWGWN8GY?th=1&psc=1");
  } finally {
    m.restaurar();
  }
});

test("host de produto Amazon: devolve o próprio link (sem rede)", async () => {
  const m = mockFetch(async () => resJson({}));
  try {
    const url = "https://www.amazon.com.br/dp/B0DWGWN8GY";
    assert.equal(await expandirCurtoAmazon(url), url);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
  }
});

test("encurtador sem redirect: null (chamador mantém o original)", async () => {
  const m = mockFetch(async (_url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    return new Response("nada", { status: 200 });
  });
  try {
    assert.equal(await expandirCurtoAmazon("https://amzn.to/3XYZabc"), null);
  } finally {
    m.restaurar();
  }
});
