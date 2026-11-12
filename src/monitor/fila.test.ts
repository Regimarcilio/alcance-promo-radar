/** Testes da fila do monitor: reenfileirar preserva a oferta (não perde no rate limit). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch, resJson } from "./test-utils.js";

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

// ---------- issue #49: ACK, retry e DLQ na fila do Monitor ----------

/** Prepara o data dir do Monitor com autoEnviar ligado. */
async function carregarFilaMonitor() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-fila-mon-"));
  writeFileSync(
    join(dir, "monitor.json"),
    JSON.stringify({ regras: [], autoEnviar: true, foto: "origem", criadoEm: new Date().toISOString() })
  );
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  const mod = await import(`./fila.js?v=${Math.random()}`);
  return { mod, dir };
}

/** Mock da Evolution (estado open + sendText). */
function mockEvolution(op: { falhar?: boolean; status?: number; corpo?: string } = {}) {
  return mockFetch(async (url: string) => {
    if (url.includes("/instance/connectionState/")) {
      return resJson({ instance: { state: "open" } });
    }
    if (url.includes("/message/sendText/")) {
      if (op.falhar) {
        return new Response(op.corpo ?? "Connection Closed", { status: op.status ?? 500 });
      }
      return resJson({ key: { id: "msg-mon" } });
    }
    return resJson({});
  });
}

test("fila do monitor: ACK — o item só sai da fila depois do envio com sucesso", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution();
  try {
    mod.enfileirar(ITEM);
    assert.equal(mod.tamanhoFila(), 1);
    await mod.liberarProximo();
    assert.equal(mod.tamanhoFila(), 0, "a fila esvazia só depois do ACK");
    assert.equal(mod.statsMonitor().processadas, 1);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: falha transitória reenfileira sem duplicar o item em andamento", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    const criado = mod.enfileirar(ITEM);
    await mod.liberarProximo();
    assert.equal(mod.tamanhoFila(), 1, "o item continua na fila");
    assert.equal(mod.itensFila().length, 1, "não duplica o item em andamento");
    assert.equal(mod.itensFila()[0].id, criado.id, "é o MESMO item");
    assert.equal(mod.itensFila()[0].tentativas, 1, "as tentativas contam");
    assert.equal(mod.emAndamento(), null, "o item não fica em andamento");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: erro permanente vai para a DLQ com o motivo", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 400, corpo: "invalid number" });
  try {
    mod.enfileirar(ITEM);
    await mod.liberarProximo();
    const dlq = mod.dlqMonitor();
    assert.equal(dlq.length, 1, "o destino que falhou foi para a DLQ");
    assert.match(dlq[0].motivo, /não transitório/);
    assert.ok(dlq[0].ultimoErro);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: tentativas esgotadas vão para a DLQ", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    const criado = mod.enfileirar(ITEM);
    // já falhou 3 vezes (o limite atual do Monitor)
    mod.reenfileirar({ ...criado, tentativas: 3 });
    await mod.liberarProximo();
    const dlq = mod.dlqMonitor();
    assert.equal(dlq.length, 1, "vai para a DLQ");
    assert.match(dlq[0].motivo, /tentativas esgotadas/);
    assert.equal(dlq[0].tentativas, 4);
    assert.equal(mod.tamanhoFila(), 0, "sai da fila");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: reprocessar devolve o item da DLQ para a fila", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    const criado = mod.enfileirar(ITEM);
    mod.reenfileirar({ ...criado, tentativas: 3 });
    await mod.liberarProximo();
    assert.equal(mod.dlqMonitor().length, 1);
    const ok = mod.reprocessarDlq(mod.dlqMonitor()[0].id);
    assert.equal(ok, true);
    assert.equal(mod.dlqMonitor().length, 0, "sai da DLQ");
    assert.equal(mod.tamanhoFila(), 1, "volta para a fila");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
