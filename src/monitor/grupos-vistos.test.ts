import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function mod(dir: string) {
  process.env.ALCANCE_DATA_DIR = dir;
  return import(`./grupos-vistos.js?v=${Math.random()}`);
}

test("registra grupo só quando há link e preço", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-vistos-"));
  try {
    const m = await mod(dir);
    assert.equal(m.registrarOfertaDeGrupo("1203631@g.us", "sem link R$ 10"), false);
    assert.equal(m.registrarOfertaDeGrupo("1203631@g.us", "https://amazon.com.br/dp/B0X sem preço"), false);
    assert.equal(m.registrarOfertaDeGrupo("1203631@g.us", "Oferta R$ 10 https://amazon.com.br/dp/B0X"), true);
    const lista = m.listarGruposComOferta(7);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].jid, "1203631@g.us");
    assert.equal(lista[0].ofertas, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
