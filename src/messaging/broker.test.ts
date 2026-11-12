/** Testes do broker: persistência em arquivo, ack/nack, DLQ e migração. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criarEnvelope } from "./envelope.js";
import {
  FileBroker,
  getBroker,
  migrarLegado,
  resetBroker,
  setBroker,
  type Broker,
} from "./broker.js";

/** Cria um broker com data dir temporário. */
function novoBroker(): { broker: FileBroker; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "alcance-broker-"));
  process.env.ALCANCE_DATA_DIR = dir;
  return { broker: new FileBroker(), dir };
}

function lerFila(dir: string, tipo: string): any[] {
  const raw = JSON.parse(readFileSync(join(dir, "messaging", `${tipo}.json`), "utf8"));
  return Array.isArray(raw) ? raw : [];
}

test("broker: 3 mensagens publicadas viram 3 envelopes no arquivo", async () => {
  const { broker, dir } = novoBroker();
  try {
    for (let i = 0; i < 3; i++) {
      await broker.publish(criarEnvelope("cliente.enviar", { n: i }));
    }
    assert.equal(broker.tamanho("cliente.enviar"), 3);
    const arquivo = join(dir, "messaging", "cliente.enviar.json");
    assert.ok(existsSync(arquivo), "o arquivo da fila deve existir");
    const itens = lerFila(dir, "cliente.enviar");
    assert.equal(itens.length, 3);
    assert.equal(itens[0].tipo, "cliente.enviar");
    assert.equal(itens[0].versao, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker: ack remove a mensagem da fila e conta processada", async () => {
  const { broker, dir } = novoBroker();
  try {
    const env = criarEnvelope("cliente.enviar", { n: 1 });
    await broker.publish(env);
    await broker.ack(env.id);
    assert.equal(broker.tamanho("cliente.enviar"), 0);
    const st = broker.stats("cliente.enviar");
    assert.equal(st.pendentes, 0);
    assert.equal(st.processadas, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker: nack devolve à fila com tentativas + 1 (não perde a mensagem)", async () => {
  const { broker, dir } = novoBroker();
  try {
    const env = criarEnvelope("cliente.enviar", { n: 1 });
    await broker.publish(env);
    await broker.nack(env.id, "Connection Closed");
    assert.equal(broker.tamanho("cliente.enviar"), 1, "a mensagem continua na fila");
    const itens = lerFila(dir, "cliente.enviar");
    assert.equal(itens[0].tentativas, 1);
    const st = broker.stats("cliente.enviar");
    assert.equal(st.falhas, 1);
    assert.equal(st.pendentes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker: DLQ + reprocessar devolve o item para a fila", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-broker-"));
  process.env.ALCANCE_DATA_DIR = dir;
  // política de nack que manda para a DLQ em vez de reenfileirar (issue #49)
  const broker = new FileBroker({
    politicaNack: async (ctx) => {
      await ctx.paraDlq({
        id: ctx.envelope.id,
        tipo: ctx.tipo,
        envelope: ctx.envelope,
        motivo: ctx.erro,
        ultimoErro: ctx.erro,
        tentativas: ctx.tentativas,
        ultimaTentativaEm: new Date().toISOString(),
        origem: null,
      });
    },
  });
  try {
    const env = criarEnvelope("cliente.enviar", { n: 1 });
    await broker.publish(env);
    await broker.nack(env.id, "erro permanente");
    assert.equal(broker.tamanho("cliente.enviar"), 0, "o item saiu da fila para a DLQ");
    assert.equal(broker.dlq("cliente.enviar").length, 1);
    assert.equal(broker.dlq("cliente.enviar")[0].ultimoErro, "erro permanente");
    await broker.reprocessar(env.id);
    assert.equal(broker.dlq("cliente.enviar").length, 0);
    assert.equal(broker.tamanho("cliente.enviar"), 1, "o item volta para a fila");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker: stats devolve pendentes, processadas, falhas, dlq e maisAntigaEm", async () => {
  const { broker, dir } = novoBroker();
  try {
    const antigo = criarEnvelope("cliente.enviar", { n: 1 }, { timestamp: "2026-01-01T00:00:00.000Z" });
    const novo = criarEnvelope("cliente.enviar", { n: 2 });
    await broker.publish(antigo);
    await broker.publish(novo);
    await broker.ack(novo.id);
    const st = broker.stats("cliente.enviar");
    assert.equal(st.pendentes, 1);
    assert.equal(st.processadas, 1);
    assert.equal(st.dlq, 0);
    assert.equal(st.maisAntigaEm, "2026-01-01T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker: migração do legado não perde item e é idempotente", async () => {
  const { broker, dir } = novoBroker();
  try {
    const legado = join(dir, "clientes-fila.json");
    writeFileSync(
      legado,
      JSON.stringify({
        itens: [
          { id: "leg-1", jid: "a@s.whatsapp.net", nome: "A", texto: "oi", criadoEm: "2026-01-01T00:00:00.000Z" },
          { id: "leg-2", jid: "b@s.whatsapp.net", nome: "B", texto: "oi", criadoEm: "2026-01-01T00:00:00.000Z" },
        ],
        ultimoEnvio: null,
        enviados: 0,
        erros: 0,
        pausado: false,
      })
    );
    const mapear = (item: any) =>
      criarEnvelope("cliente.enviar", item, {
        id: item.id,
        timestamp: item.criadoEm,
      });
    const n = migrarLegado(broker, { tipo: "cliente.enviar", arquivo: legado, mapear });
    assert.equal(n, 2);
    assert.equal(broker.tamanho("cliente.enviar"), 2);
    const itens = lerFila(dir, "cliente.enviar");
    assert.deepEqual(itens.map((i) => i.id).sort(), ["leg-1", "leg-2"]);
    // idempotente: rodar de novo não duplica
    const n2 = migrarLegado(broker, { tipo: "cliente.enviar", arquivo: legado, mapear });
    assert.equal(n2, 0);
    assert.equal(broker.tamanho("cliente.enviar"), 2);
    // o arquivo legado NÃO é apagado (o worker legado ainda depende dele até a #49)
    assert.ok(existsSync(legado));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker: é substituível — o produtor usa o adapter registrado", async () => {
  const recebido: any[] = [];
  const adapter: Broker = {
    async publish(env) {
      recebido.push(env);
    },
    consume() {},
    async ack() {},
    async nack() {},
    tamanho: () => 0,
    dlq: () => [],
    async reprocessar() {},
    stats: () => ({ pendentes: 0, processadas: 0, falhas: 0, dlq: 0, maisAntigaEm: null }),
  };
  resetBroker();
  try {
    setBroker(adapter);
    const env = criarEnvelope("cliente.enviar", { n: 1 });
    await getBroker().publish(env);
    assert.equal(recebido.length, 1);
    assert.equal(recebido[0].id, env.id);
  } finally {
    resetBroker();
  }
});
