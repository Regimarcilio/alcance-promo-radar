/** Segurança do envio: allowlist de mídia local e anti-SSRF em URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarImagem } from "./dispatch.js";

test("validarImagem: aceita vazio, https público e data:image", () => {
  assert.doesNotThrow(() => validarImagem(""));
  assert.doesNotThrow(() => validarImagem("https://cdn.exemplo.com/foto.jpg"));
  assert.doesNotThrow(() => validarImagem("data:image/png;base64,AAAA"));
});

test("validarImagem: recusa path traversal e caminho arbitrário", () => {
  assert.throws(() => validarImagem("/etc/passwd"));
  assert.throws(() => validarImagem("data/midia/../../etc/passwd"));
  assert.throws(() => validarImagem("../../etc/passwd"));
});

test("validarImagem: recusa SSRF (loopback, privado, link-local, credenciais)", () => {
  assert.throws(() => validarImagem("http://127.0.0.1/x.jpg"));
  assert.throws(() => validarImagem("http://localhost/x.jpg"));
  assert.throws(() => validarImagem("http://10.0.0.5/x.jpg"));
  assert.throws(() => validarImagem("http://169.254.169.254/latest/meta-data"));
  assert.throws(() => validarImagem("https://user:pass@exemplo.com/x.jpg"));
  assert.throws(() => validarImagem("ftp://exemplo.com/x.jpg"));
});

test("validarImagem: recusa data URI que não é imagem", () => {
  assert.throws(() => validarImagem("data:text/html;base64,PHNjcmlwdD4="));
});

test("envio: se o sendMedia falhar, reenvia só o texto (não perde a oferta)", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");
  const { enviarParaGrupo } = await import("./dispatch.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [{ instancia: "inst-teste", nome: "Teste", ativo: true, peso: 1, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" }],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  let media = 0;
  let texto = 0;
  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) return new Response(JSON.stringify({ instance: { state: "open" } }), { headers: { "content-type": "application/json" } });
    if (url.includes("cdn.exemplo.com")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    if (url.includes("/message/sendMedia/")) { media++; return new Response(JSON.stringify({ status: 500 }), { status: 500 }); }
    if (url.includes("/message/sendText/")) { texto++; return new Response(JSON.stringify({ key: { id: "txt-1" } }), { headers: { "content-type": "application/json" } }); }
    throw new Error(`url inesperada: ${url}`);
  });
  try {
    const r = await enviarParaGrupo({
      grupo: "120363000000000000@g.us",
      imagem: "https://cdn.exemplo.com/foto.jpg",
      legenda: "oferta",
      dryRun: false,
    });
    assert.equal(r.messageId, "txt-1");
    assert.equal(media, 3, "sendMedia deve esgotar as tentativas");
    assert.equal(texto, 1, "depois do media, envia o texto uma vez");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
