import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Diagnóstico do conversor: sem conta cadastrada o fallback precisa DIZER
 * "falta credencial" (e não culpar o conversor externo). Esse teste existe
 * porque a mensagem errada já custou uma conclusão errada em produção.
 */
test("converterLink sem credenciais devolve fallback com CREDENCIAL_FALTANDO", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-"));
  const salvo = { ...process.env };
  process.env.ALCANCE_DATA_DIR = dir;
  delete process.env.TAG_ML;
  delete process.env.COOKIE_ML;
  delete process.env.ML_CONVERSOR_URL;
  try {
    const { converterLink } = await import("./provider.js");
    const url = "https://produto.mercadolivre.com.br/MLB-1234567890";
    const r = await converterLink(url);
    assert.equal(r.fonte, "hunter-fallback");
    assert.equal(r.linkAfiliado, url);
    assert.match(r.aviso ?? "", /CREDENCIAL_FALTANDO/);
    assert.match(r.aviso ?? "", /Contas ML/);
  } finally {
    process.env = salvo;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dicaConversao traduz erro do createLink em ação de operação", async () => {
  const { dicaConversao } = await import("./provider.js");
  assert.match(dicaConversao("CREATELINK_401"), /Cookie/i);
  assert.match(dicaConversao("PRODUTO_FORA_DO_PROGRAMA"), /comiss/i);
  assert.match(dicaConversao("CREATELINK_500"), /inst[ií]vel|ML/i);
  assert.match(dicaConversao("QUALQUER_COISA"), /Contas ML/);
});
