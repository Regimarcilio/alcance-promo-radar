/** Testes da expansão de encurtadores Amazon (curtos.ts) — fetch mockado. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandirCurtoAmazon, expandirLink } from "./curtos.js";
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

test("encurtador genérico (tidd.ly): segue o redirect e classifica", async () => {
  const m = mockFetch(async (url) => {
    assert.match(url, /tidd\.ly/);
    return resRedirect("https://www.mercadolivre.com.br/produto/MLB-123456789");
  });
  try {
    const r = await expandirLink("https://tidd.ly/abc123");
    assert.equal(r?.programa, "mercadolivre");
    assert.equal(r?.idProduto, "MLB123456789");
  } finally {
    m.restaurar();
  }
});

test("encurtador genérico: destino sem programa conhecido devolve null", async () => {
  const m = mockFetch(async () => resRedirect("https://exemplo-qualquer.com/pagina"));
  try {
    assert.equal(await expandirLink("https://tidd.ly/abc123"), null);
  } finally {
    m.restaurar();
  }
});

test("link.amazon → amzlinks.in: segue os dois saltos e acha o produto", async () => {
  const m = mockFetch(async (url) => {
    if (url.includes("link.amazon")) return resRedirect("https://amzlinks.in/B0ABC12345");
    if (url.includes("amzlinks.in")) return resRedirect("https://www.amazon.com.br/dp/B0ABC12345?tag=origem-20");
    return new Response(null, { status: 404 });
  });
  try {
    const r = await expandirLink("https://link.amazon/B0ABC12345");
    assert.equal(r?.programa, "amazon");
    assert.equal(r?.idProduto, "B0ABC12345");
  } finally {
    m.restaurar();
  }
});

test("shozap → link.amazon → amzlinks.in: resolve a cadeia de 3 saltos", async () => {
  const m = mockFetch(async (url) => {
    if (url.includes("shozap.com.br")) return resRedirect("https://link.amazon/B0XYZ98765");
    if (url.includes("link.amazon")) return resRedirect("https://amzlinks.in/B0XYZ98765");
    if (url.includes("amzlinks.in")) return resRedirect("https://www.amazon.com.br/dp/B0XYZ98765?tag=origem-20");
    return new Response(null, { status: 404 });
  });
  try {
    const r = await expandirLink("https://amazon.shozap.com.br/abc123");
    assert.equal(r?.programa, "amazon");
    assert.equal(r?.idProduto, "B0XYZ98765");
  } finally {
    m.restaurar();
  }
});

test("mercadolivre.com: segue redirect e classifica como ML", async () => {
  const m = mockFetch(async (url) => {
    if (url.includes("mercadolivre.com")) return resRedirect("https://produto.mercadolivre.com.br/MLB-123456789-produto");
    return new Response(null, { status: 404 });
  });
  try {
    const r = await expandirLink("https://mercadolivre.com/sec/abc123");
    assert.equal(r?.programa, "mercadolivre");
    assert.equal(r?.idProduto, "MLB123456789");
  } finally {
    m.restaurar();
  }
});

test("link.emipefps.com: resolve pelo RPC get_link_by_slug", async () => {
  const m = mockFetch(async (url) => {
    if (url.includes("get_link_by_slug")) {
      return resJson([{ resolved_url: "https://www.amazon.com.br/dp/B0EPIPE123?tag=origem-20" }]);
    }
    return new Response(null, { status: 404 });
  });
  try {
    const r = await expandirLink("https://link.emipefps.com/abc123");
    assert.equal(r?.programa, "amazon");
    assert.equal(r?.idProduto, "B0EPIPE123");
  } finally {
    m.restaurar();
  }
});
