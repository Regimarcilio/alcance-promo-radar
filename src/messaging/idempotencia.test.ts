/** Testes da idempotência: chaves por tipo e registro de processados. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chaveDe,
  criarRegistro,
  estatisticasIdempotencia,
  jaProcessado,
  limparProcessados,
  registrarProcessado,
} from "./idempotencia.js";

async function carregar() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-idem-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./idempotencia.js?v=${Math.random()}`);
  return { mod, dir };
}

test("idempotência: a chave de cliente.enviar é derivada do disparo e do contato", async () => {
  const { mod, dir } = await carregar();
  try {
    const a = mod.chaveDe("cliente.enviar", { disparoId: "promo-1", jid: "5511999999999" });
    const b = mod.chaveDe("cliente.enviar", { disparoId: "promo-1", jid: "5511988888888" });
    assert.equal(a, "promo-1:5511999999999");
    assert.notEqual(a, b, "contatos diferentes na mesma campanha → chaves diferentes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotência: mesmo contato em campanhas diferentes não colide", async () => {
  const { mod, dir } = await carregar();
  try {
    const a = mod.chaveDe("cliente.enviar", { disparoId: "promo-1", jid: "5511999999999" });
    const b = mod.chaveDe("cliente.enviar", { disparoId: "promo-2", jid: "5511999999999" });
    assert.notEqual(a, b, "campanhas diferentes → chaves diferentes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotência: o registro marca a chave como processada", async () => {
  const { mod, dir } = await carregar();
  try {
    assert.equal(mod.jaProcessado("promo-1:5511999999999"), false);
    mod.registrarProcessado("promo-1:5511999999999", "cliente.enviar");
    assert.equal(mod.jaProcessado("promo-1:5511999999999"), true);
    const st = mod.estatisticasIdempotencia();
    assert.equal(st.total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotência: a retenção remove as chaves antigas", async () => {
  const { mod, dir } = await carregar();
  try {
    // chave antiga (40 dias) registrada com data retroativa
    const registro = mod.criarRegistro({
      arquivo: join(dir, "messaging", "processados.json"),
      retencaoDias: 30,
      limite: 100,
    });
    // chave expirada (40 dias) é removida na hora da gravação
    registro.registrar("velha", { data: new Date(Date.now() - 40 * 86400000).toISOString() });
    assert.equal(registro.tamanho(), 0, "a chave expirada não fica guardada");
    assert.equal(registro.tem("velha"), false, "a chave expirada não conta mais");
    // chave dentro da retenção fica
    registro.registrar("nova");
    assert.equal(registro.tamanho(), 1);
    assert.equal(registro.tem("nova"), true);
    assert.equal(registro.limparExpiradas(), 0, "não há o que limpar (a chave nova é válida)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotência: o limite de tamanho mantém o registro limitado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-idem-"));
  try {
    const registro = criarRegistro({
      arquivo: join(dir, "processados.json"),
      retencaoDias: 30,
      limite: 5,
    });
    for (let i = 0; i < 12; i++) registro.registrar(`k${i}`);
    assert.equal(registro.tamanho(), 5, "o tamanho fica limitado");
    assert.equal(registro.tem("k11"), true, "as mais recentes ficam");
    assert.equal(registro.tem("k0"), false, "as mais antigas saem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotência: a chave de evento de tópico é `${tipo}:${id}`", async () => {
  const { mod, dir } = await carregar();
  try {
    assert.equal(mod.chaveDe("disparo.criado", { id: "abc" }), "disparo.criado:abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
