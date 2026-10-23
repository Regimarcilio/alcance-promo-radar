/** Testes da fila do monitor: reenfileirar preserva a oferta (não perde no rate limit). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function carregarFila() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-fila-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./fila.js?v=${Math.random()}`);
  return { mod, dir };
}

const ITEM = {
  origem: "120363@g.us",
  programa: "mercadolivre",
  idProduto: "MLB123",
  link: "https://x",
  mensagem: "oi",
  imagem: "",
  destinos: ["120363999@g.us"],
};

test("fila: reenfileirar devolve o MESMO item (id preservado)", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar(ITEM);
    // simula o item ter sido retirado da fila (liberado) e devolvido
    const s = JSON.parse(readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    s.itens = [];
    const fs = await import("node:fs");
    fs.writeFileSync(join(dir, "monitor-fila.json"), JSON.stringify(s, null, 2));

    const devolvido = mod.reenfileirar({ ...criado, tentativas: 1 });
    assert.equal(devolvido.id, criado.id, "o id tem que ser o mesmo (a oferta não pode duplicar)");
    const salvo = JSON.parse(readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    assert.equal(salvo.itens.length, 1);
    assert.equal(salvo.itens[0].id, criado.id);
    assert.equal(salvo.itens[0].tentativas, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: reenfileirar não duplica o mesmo item", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar(ITEM);
    mod.reenfileirar(criado);
    mod.reenfileirar(criado);
    const salvo = JSON.parse(readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    assert.equal(salvo.itens.length, 1, "não pode duplicar o mesmo item na fila");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: reenfileirar preserva os destinos restantes", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar({ ...ITEM, destinos: ["a@g.us", "b@g.us"] });
    const devolvido = mod.reenfileirar({ ...criado, destinos: ["b@g.us"], tentativas: 1 });
    assert.deepEqual(devolvido.destinos, ["b@g.us"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: recuperarEmAndamento devolve item interrompido no boot", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar(ITEM);
    const fs = await import("node:fs");
    const s = JSON.parse(fs.readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    s.itens = [];
    s.emAndamento = { item: criado, desde: new Date().toISOString() };
    fs.writeFileSync(join(dir, "monitor-fila.json"), JSON.stringify(s, null, 2));

    assert.equal(mod.tamanhoFila(), 0);
    assert.equal(mod.recuperarEmAndamento(), 1);
    assert.equal(mod.tamanhoFila(), 1);
    assert.equal(mod.itensFila()[0].id, criado.id);
    assert.equal(mod.recuperarEmAndamento(), 0, "não duplica na segunda chamada");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
