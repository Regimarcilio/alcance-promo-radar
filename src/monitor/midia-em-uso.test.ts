/**
 * REGRESSÃO issue #82 — DLQ e retenção de mídia.
 *
 * Cobre:
 * - `midiaEmUso()` (fila do Monitor): a faxina de retenção NÃO pode apagar a
 *   mídia que ainda está referenciada por um item na fila, uma mensagem na
 *   DLQ ou um disparo incompleto;
 * - `reprocessarItemDlq`: quando a mídia sumiu, o item volta para a fila
 *   **só com o texto** (antes ele morria de novo pelo mesmo motivo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function ambiente() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-midia-em-uso-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const fs = await import("node:fs");
  fs.mkdirSync(join(dir, "midia"), { recursive: true });
  fs.writeFileSync(join(dir, "instancias.json"), JSON.stringify({ itens: [] }));
  fs.writeFileSync(join(dir, "disparos.json"), JSON.stringify([]));
  return { dir, fs };
}

/** Grava um arquivo de mídia e devolve o caminho. */
function midia(dir: string, ext = "mp4"): string {
  const p = join(dir, "midia", `${randomUUID()}.${ext}`);
  writeFileSync(p, "conteudo");
  return p;
}

test("midiaEmUso: considera a mídia de disparo incompleto", async () => {
  const { dir, fs } = await ambiente();
  try {
    const arquivo = midia(dir);
    fs.writeFileSync(
      join(dir, "disparos.json"),
      JSON.stringify([
        {
          id: "d1",
          em: new Date().toISOString(),
          atualizadoEm: new Date().toISOString(),
          listaId: null,
          listaNome: null,
          texto: "x",
          link: null,
          midia: { arquivo, mime: "video/mp4", tipo: "video" },
          jids: [],
          total: 10,
          enviados: 1,
          falhas: 0,
          status: "PARCIAL",
        },
      ]),
    );
    const mod = await import(`./fila.js?v=${Math.random()}`);
    const emUso = mod.midiaEmUso();
    assert.ok(emUso.has(arquivo.split("/").pop()!), "mídia do disparo incompleto tem que estar protegida");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("midiaEmUso: NÃO protege a mídia de disparo concluído", async () => {
  const { dir, fs } = await ambiente();
  try {
    const arquivo = midia(dir);
    fs.writeFileSync(
      join(dir, "disparos.json"),
      JSON.stringify([
        {
          id: "d2",
          em: new Date().toISOString(),
          atualizadoEm: new Date().toISOString(),
          listaId: null,
          listaNome: null,
          texto: "x",
          link: null,
          midia: { arquivo, mime: "video/mp4", tipo: "video" },
          jids: [],
          total: 10,
          enviados: 10,
          falhas: 0,
          status: "CONCLUIDO",
        },
      ]),
    );
    const mod = await import(`./fila.js?v=${Math.random()}`);
    const emUso = mod.midiaEmUso();
    assert.equal(emUso.has(arquivo.split("/").pop()!), false, "disparo concluído libera a mídia");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("midiaEmUso: protege a mídia de item na fila da Mensageria", async () => {
  const { dir } = await ambiente();
  try {
    const arquivo = midia(dir);
    const brokerMod = await import(`../messaging/broker.js?v=${Math.random()}`);
    const envMod = await import(`../messaging/envelope.js?v=${Math.random()}`);
    brokerMod.resetBroker();
    const broker = brokerMod.getBroker();
    const env = envMod.criarEnvelope(
      "cliente.enviar",
      { id: "x", jid: "1@s.whatsapp.net", nome: "x", texto: "t", imagem: arquivo, disparoId: "d3" },
      { id: randomUUID() },
    );
    await broker.publish(env);

    const mod = await import(`./fila.js?v=${Math.random()}`);
    const emUso = mod.midiaEmUso();
    assert.ok(emUso.has(arquivo.split("/").pop()!), "mídia de item pendente tem que estar protegida");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DLQ: reprocessar item cuja mídia sumiu devolve o envelope só com o texto", async () => {
  const { dir } = await ambiente();
  try {
    const arquivo = midia(dir);
    // a mídia some (faxina de retenção)
    rmSync(arquivo);

    const brokerMod = await import(`../messaging/broker.js?v=${Math.random()}`);
    const envMod = await import(`../messaging/envelope.js?v=${Math.random()}`);
    const dlqMod = await import(`../messaging/dlq.js?v=${Math.random()}`);
    brokerMod.resetBroker();
    const broker = brokerMod.getBroker();

    const env = envMod.criarEnvelope(
      "cliente.enviar",
      {
        id: "y",
        jid: "5511999999999@s.whatsapp.net",
        nome: "y",
        texto: "oferta com link",
        imagem: arquivo,
        midia: { arquivo, mime: "video/mp4", tipo: "video" },
        disparoId: "d4",
      },
      { id: randomUUID() },
    );
    // o item morre na DLQ
    dlqMod.registrarDlq({
      id: env.id,
      tipo: env.tipo,
      envelope: env,
      motivo: "erro não transitório",
      ultimoErro: "caminho de mídia não permitido",
      tentativas: 1,
      ultimaTentativaEm: new Date().toISOString(),
    });

    const ops = await import(`../messaging/dlq-operacoes.js?v=${Math.random()}`);
    const r = await ops.reprocessarItemDlq(env.id);
    assert.equal(r.ok, true, "o reprocessamento tem que funcionar");

    const pendentes = broker.pendentes?.("cliente.enviar") ?? [];
    const naFila = pendentes.find((e: any) => e.id === env.id);
    assert.ok(naFila, "o envelope tem que voltar para a fila");
    const payload = naFila.payload as any;
    assert.equal(payload.imagem, "", "a mídia que sumiu não pode voltar para a fila");
    assert.equal(payload.midia, null);
    assert.equal(payload.texto, "oferta com link", "o texto tem que ser preservado");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DLQ: reprocessar item com mídia VÁLIDA mantém a mídia", async () => {
  const { dir } = await ambiente();
  try {
    const arquivo = midia(dir);
    const brokerMod = await import(`../messaging/broker.js?v=${Math.random()}`);
    const envMod = await import(`../messaging/envelope.js?v=${Math.random()}`);
    const dlqMod = await import(`../messaging/dlq.js?v=${Math.random()}`);
    brokerMod.resetBroker();
    const broker = brokerMod.getBroker();

    const env = envMod.criarEnvelope(
      "cliente.enviar",
      { id: "z", jid: "1@s.whatsapp.net", nome: "z", texto: "t", imagem: arquivo, disparoId: "d5" },
      { id: randomUUID() },
    );
    dlqMod.registrarDlq({
      id: env.id,
      tipo: env.tipo,
      envelope: env,
      motivo: "erro não transitório",
      ultimoErro: "timeout",
      tentativas: 1,
      ultimaTentativaEm: new Date().toISOString(),
    });

    const ops = await import(`../messaging/dlq-operacoes.js?v=${Math.random()}`);
    const r = await ops.reprocessarItemDlq(env.id);
    assert.equal(r.ok, true);

    const naFila = (broker.pendentes?.("cliente.enviar") ?? []).find((e: any) => e.id === env.id);
    assert.ok(naFila);
    assert.equal((naFila.payload as any).imagem, arquivo, "mídia válida continua intacta");
    assert.equal(existsSync(arquivo), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
