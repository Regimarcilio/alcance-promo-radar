/** Testes dos tópicos (Pub/Sub): fan-out, falha isolada, reentrega e correlação. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "./envelope.js";

async function carregarEventos() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-eventos-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./eventos.js?v=${Math.random()}`);
  return { mod, dir };
}

test("tópico: todos os assinantes recebem o evento", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    const a: Envelope[] = [];
    const b: Envelope[] = [];
    mod.assinarEvento("disparo.criado", "a", async (e: Envelope) => { a.push(e); });
    mod.assinarEvento("disparo.criado", "b", async (e: Envelope) => { b.push(e); });
    mod.publicarEvento("disparo.criado", { disparoId: "d1", total: 3 });
    await mod.processarPendentes("disparo.criado");
    assert.equal(a.length, 1, "o assinante A recebeu");
    assert.equal(b.length, 1, "o assinante B recebeu");
    assert.equal((a[0].payload as any).disparoId, "d1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: assinante com falha não afeta os outros", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    const ok: Envelope[] = [];
    mod.assinarEvento("disparo.criado", "quebrado", async () => {
      throw new Error("assinante fora do ar");
    });
    mod.assinarEvento("disparo.criado", "saudavel", async (e: Envelope) => { ok.push(e); });
    mod.publicarEvento("disparo.criado", { disparoId: "d2", total: 1 });
    await mod.processarPendentes("disparo.criado");
    assert.equal(ok.length, 1, "o assinante saudável processa normalmente");
    const pendentes = mod.estadoAssinantes().find((x: any) => x.nome === "quebrado");
    assert.equal(pendentes?.pendentes, 1, "o que falhou fica na fila do assinante para reprocessar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: assinante que estava fora do ar recebe o que perdeu", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    const recebidos: Envelope[] = [];
    // assinante com handler que falha: o evento fica na fila dele
    mod.assinarEvento("disparo.criado", "volta", async () => {
      throw new Error("offline");
    });
    mod.publicarEvento("disparo.criado", { disparoId: "d3", total: 1 });
    await mod.processarPendentes("disparo.criado");
    assert.equal(mod.estadoAssinantes().find((x: any) => x.nome === "volta")?.pendentes, 1);

    // o assinante volta (se reinscreve com handler bom) → recebe o pendente
    mod.assinarEvento("disparo.criado", "volta", async (e: Envelope) => { recebidos.push(e); });
    await mod.processarPendentes("disparo.criado");
    assert.equal(recebidos.length, 1, "recebeu o evento pendente");
    assert.equal((recebidos[0].payload as any).disparoId, "d3");
    assert.equal(mod.estadoAssinantes().find((x: any) => x.nome === "volta")?.pendentes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: assinante novo não recebe o histórico", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    // evento publicado antes de existir assinante
    mod.publicarEvento("disparo.criado", { disparoId: "antigo", total: 1 });
    const recebidos: Envelope[] = [];
    mod.assinarEvento("disparo.criado", "novo", async (e: Envelope) => { recebidos.push(e); });
    await mod.processarPendentes("disparo.criado");
    assert.equal(recebidos.length, 0, "o assinante novo não recebe o evento antigo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: o correlationId atravessa os eventos do mesmo fluxo", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    const recebidos: Envelope[] = [];
    mod.assinarEvento("disparo.criado", "rastro", async (e: Envelope) => { recebidos.push(e); });
    mod.assinarEvento("disparo.mensagem.enviada", "rastro", async (e: Envelope) => { recebidos.push(e); });
    mod.publicarEvento("disparo.criado", { disparoId: "d4", total: 1 }, { correlationId: "abc-123" });
    mod.publicarEvento(
      "disparo.mensagem.enviada",
      { disparoId: "d4", jid: "5511999999999@s.whatsapp.net", ok: true },
      { correlationId: "abc-123" }
    );
    await mod.processarPendentes();
    assert.equal(recebidos.length, 2);
    assert.ok(recebidos.every((e) => e.correlationId === "abc-123"), "todos com o mesmo correlationId");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: payload inválido é rejeitado na publicação", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    assert.throws(
      () => mod.publicarEvento("disparo.criado", { disparoId: "d5" } as any),
      /payload inválido/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: o produtor não conhece nem é afetado pelos assinantes", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    mod.assinarEvento("disparo.criado", "explodido", async () => {
      throw new Error("falhou feio");
    });
    // publicar não pode lançar por causa do assinante
    const env = mod.publicarEvento("disparo.criado", { disparoId: "d6", total: 1 });
    assert.equal(env.tipo, "disparo.criado");
    assert.equal(env.versao, 1);
    assert.ok(env.id && env.correlationId && env.timestamp);
    assert.equal(env.chave, `disparo.criado:${env.id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tópico: desassinar remove o assinante (a fila dele é preservada)", async () => {
  const { mod, dir } = await carregarEventos();
  try {
    const recebidos: Envelope[] = [];
    mod.assinarEvento("disparo.criado", "temporario", async (e: Envelope) => { recebidos.push(e); });
    mod.desassinarEvento("disparo.criado", "temporario");
    mod.publicarEvento("disparo.criado", { disparoId: "d7", total: 1 });
    await mod.processarPendentes("disparo.criado");
    assert.equal(recebidos.length, 0, "quem desassinou não recebe mais");
    assert.equal(mod.estadoAssinantes().find((x: any) => x.nome === "temporario"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
