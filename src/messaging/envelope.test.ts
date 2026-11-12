/** Testes do envelope: criação, validação e herança de correlação. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comCorrelacao,
  correlacaoAtual,
  criarEnvelope,
  EnvelopeInvalidoError,
  envelopeValido,
  validarEnvelope,
  VERSAO_ENVELOPE,
} from "./envelope.js";

test("envelope: criação preenche id, tipo, versão, timestamp, correlationId e payload", () => {
  const env = criarEnvelope("cliente.enviar", { texto: "oi" });
  assert.equal(env.tipo, "cliente.enviar");
  assert.equal(env.versao, VERSAO_ENVELOPE);
  assert.equal(env.versao, 1);
  assert.ok(env.id.length > 0);
  assert.ok(env.correlationId.length > 0);
  assert.ok(!Number.isNaN(Date.parse(env.timestamp)));
  assert.equal(env.tentativas, 0);
  assert.deepEqual(env.payload, { texto: "oi" });
  assert.equal(env.chave, undefined, "sem chave explícita o envelope não tem o campo");
});

test("envelope: JSON puro (sem undefined/Date)", () => {
  const env = criarEnvelope("cliente.enviar", { a: 1 });
  const json = JSON.parse(JSON.stringify(env));
  assert.deepEqual(Object.keys(json).sort(), [
    "correlationId",
    "id",
    "payload",
    "tentativas",
    "timestamp",
    "tipo",
    "versao",
  ]);
});

test("envelope: sem tipo a validação falha com o campo faltante", () => {
  const env = criarEnvelope("cliente.enviar", {});
  const { tipo, ...semTipo } = env;
  assert.throws(
    () => validarEnvelope(semTipo),
    (e: any) => e instanceof EnvelopeInvalidoError && e.campos.includes("tipo"),
  );
});

test("envelope: sem correlationId a validação falha com o campo faltante", () => {
  const env = criarEnvelope("cliente.enviar", {});
  const { correlationId, ...semCorrelacao } = env;
  assert.throws(
    () => validarEnvelope(semCorrelacao),
    (e: any) => e instanceof EnvelopeInvalidoError && e.campos.includes("correlationId"),
  );
});

test("envelope: envelope válido passa na validação", () => {
  const env = criarEnvelope("cliente.enviar", { a: 1 });
  assert.equal(envelopeValido(env), true);
  assert.equal(validarEnvelope(env).id, env.id);
});

test("envelope: correlação herdada do contexto", () => {
  const herdado = comCorrelacao("abc-123", () => {
    assert.equal(correlacaoAtual(), "abc-123");
    return criarEnvelope("cliente.enviar", {});
  });
  assert.equal(herdado.correlationId, "abc-123");
});

test("envelope: correlationId explícito tem prioridade sobre o contexto", () => {
  const env = comCorrelacao("ctx-1", () => criarEnvelope("cliente.enviar", {}, { correlationId: "explicito" }));
  assert.equal(env.correlationId, "explicito");
});

test("envelope: fora do contexto cada envelope recebe seu próprio correlationId", () => {
  const a = criarEnvelope("cliente.enviar", {});
  const b = criarEnvelope("cliente.enviar", {});
  assert.notEqual(a.correlationId, b.correlationId);
});
