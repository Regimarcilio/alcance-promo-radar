/** Testes da DM de boas-vindas (texto, imagem, dedup e estado). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGENDA_PADRAO,
  caminhoImagemBoasVindas,
  estadoBoasVindas,
  jaEnviado,
  legendaBoasVindas,
  normalizarNumeroBoasVindas,
  registrarBoasVindas,
  validarImagemBoasVindas,
} from "./boas-vindas.js";

function comDataDir(): { dir: string; restaurar: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "alcance-bv-"));
  const anterior = process.env.ALCANCE_DATA_DIR;
  process.env.ALCANCE_DATA_DIR = dir;
  return {
    dir,
    restaurar: () => {
      if (anterior === undefined) delete process.env.ALCANCE_DATA_DIR;
      else process.env.ALCANCE_DATA_DIR = anterior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("legenda padrão tem boas-vindas e o link do TikTok", () => {
  const texto = legendaBoasVindas();
  assert.match(texto, /Bem-vindo ao Mano dos Achadinhos/);
  assert.match(texto, /https:\/\/www\.tiktok\.com\/@mano\.dos\.achadinh/);
  assert.equal(texto, LEGENDA_PADRAO);
});

test("legenda pode ser sobrescrita por env", () => {
  const anterior = process.env.BOAS_VINDAS_LEGENDA;
  process.env.BOAS_VINDAS_LEGENDA = "texto de teste";
  try {
    assert.equal(legendaBoasVindas(), "texto de teste");
  } finally {
    if (anterior === undefined) delete process.env.BOAS_VINDAS_LEGENDA;
    else process.env.BOAS_VINDAS_LEGENDA = anterior;
  }
});

test("normaliza número: só dígitos, 10–15, e recusa @lid", () => {
  assert.equal(normalizarNumeroBoasVindas("+55 (11) 99999-9999"), "5511999999999");
  assert.equal(normalizarNumeroBoasVindas("5511999999999@s.whatsapp.net"), "5511999999999");
  assert.equal(normalizarNumeroBoasVindas("123"), null);
  assert.equal(normalizarNumeroBoasVindas("1234567890123456"), null);
  assert.equal(normalizarNumeroBoasVindas("236378038222861@lid"), null);
});

test("imagem padrão existe e é aceita; caminho fora do projeto é recusado", () => {
  const caminho = caminhoImagemBoasVindas();
  assert.match(caminho, /image\/Mano dos Achadinhos_ Ofertas Tech e Lifestyle\.png$/);
  assert.equal(validarImagemBoasVindas(caminho).ok, true);
  assert.equal(validarImagemBoasVindas("/etc/passwd").ok, false);
  assert.match(validarImagemBoasVindas("/etc/passwd").erro ?? "", /fora do projeto/);
});

test("dedup: envia uma vez e não repete dentro da janela", () => {
  const ctx = comDataDir();
  try {
    assert.equal(jaEnviado("5511999999999"), false);
    registrarBoasVindas("5511999999999", { ok: true, instancia: "inst-1" });
    assert.equal(jaEnviado("5511999999999"), true);
    assert.equal(jaEnviado("5511888888888"), false);
  } finally {
    ctx.restaurar();
  }
});

test("falha não bloqueia nova tentativa", () => {
  const ctx = comDataDir();
  try {
    registrarBoasVindas("5511999999999", { ok: false, erro: "timeout" });
    assert.equal(jaEnviado("5511999999999"), false);
  } finally {
    ctx.restaurar();
  }
});

test("estado conta só envios confirmados e expõe a imagem", () => {
  const ctx = comDataDir();
  try {
    registrarBoasVindas("5511999999999", { ok: true });
    registrarBoasVindas("5511888888888", { ok: false, erro: "x" });
    const e = estadoBoasVindas();
    assert.equal(e.total, 1);
    assert.equal(e.imagemOk, true);
    assert.equal(e.ultimas.length, 2);
    assert.equal(e.ultimas[0].numero, "5511888888888");
  } finally {
    ctx.restaurar();
  }
});
