/**
 * Regressão de segurança: a mídia do painel só sai de dentro da base, só
 * imagem e sem subdiretório. Um `..` aqui viraria leitura arbitrária de arquivo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolverMidia } from "./midia.js";

const BASE = join("/projeto", "image");

test("mídia: aceita imagem direta na base", () => {
  const r = resolverMidia(BASE, "logo.png");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.alvo, join(BASE, "logo.png"));
    assert.equal(r.mime, "image/png");
  }
  const j = resolverMidia(BASE, "foto.JPEG");
  assert.equal(j.ok, true);
  if (j.ok) assert.equal(j.mime, "image/jpeg");
  const w = resolverMidia(BASE, "x.webp");
  assert.equal(w.ok, true);
  if (w.ok) assert.equal(w.mime, "image/webp");
});

test("mídia: recusa path traversal", () => {
  for (const nome of [
    "../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "sub/../../fora.png",
    "..png",
    "imagem..png",
    "....//x.png",
  ]) {
    const r = resolverMidia(BASE, nome);
    assert.equal(r.ok, false, `deveria recusar: ${nome}`);
  }
});

test("mídia: recusa subdiretório e nomes vazios/ocultos", () => {
  for (const nome of ["sub/x.png", "sub\\x.png", "", "   ", ".oculto.png"]) {
    const r = resolverMidia(BASE, nome);
    assert.equal(r.ok, false, `deveria recusar: ${JSON.stringify(nome)}`);
  }
});

test("mídia: recusa extensões não exibíveis", () => {
  for (const nome of ["script.js", "page.html", "icon.svg", "arquivo.gif", "semextensao"]) {
    const r = resolverMidia(BASE, nome);
    assert.equal(r.ok, false, `deveria recusar: ${nome}`);
  }
});

test("mídia: recusa byte nulo", () => {
  const r = resolverMidia(BASE, "logo.png\0.js");
  assert.equal(r.ok, false);
});
