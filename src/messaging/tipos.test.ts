/** Testes do catálogo de tipos: schemas zod e validação de payload. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ehTipoEvento,
  ehTipoMensagem,
  schemaDoTipo,
  TIPOS_EVENTO,
  TIPOS_MENSAGEM,
  validarPayload,
} from "./tipos.js";

test("tipos: catálogo tem os tipos de mensagem e de evento da issue", () => {
  assert.ok(TIPOS_MENSAGEM.includes("cliente.enviar" as any));
  assert.ok(TIPOS_MENSAGEM.includes("monitor.encaminhar" as any));
  assert.ok(TIPOS_EVENTO.includes("oferta.recebida" as any));
  assert.ok(TIPOS_EVENTO.includes("mensagem.dlq" as any));
  assert.equal(ehTipoMensagem("cliente.enviar"), true);
  assert.equal(ehTipoEvento("cliente.enviar"), false);
  assert.equal(ehTipoEvento("oferta.recebida"), true);
});

test("tipos: payload válido de evento é aceito", () => {
  const r = validarPayload("oferta.recebida", {
    origem: "120363@g.us",
    programa: "ml",
    idProduto: "MLB123",
    link: "https://x",
  });
  assert.equal(r.ok, true);
});

test("tipos: payload inválido de evento é rejeitado com o campo", () => {
  const r = validarPayload("oferta.recebida", { origem: "x" });
  assert.equal(r.ok, false);
  assert.match(r.erro ?? "", /payload inválido/);
  assert.match(r.erro ?? "", /programa/);
});

test("tipos: tipo sem schema aceita qualquer payload", () => {
  assert.equal(schemaDoTipo("cliente.enviar"), undefined);
  assert.equal(validarPayload("cliente.enviar", { qualquer: 1 }).ok, true);
});
