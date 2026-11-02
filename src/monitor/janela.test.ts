/** Testes da janela de envio (08:00–23:00 ± 10min, jitter determinístico por dia). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function carregarJanela() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-janela-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./janela.js?v=${Math.random()}`);
  return { mod, dir };
}

test("janela: offset determinístico em [-10,+10] para o mesmo dia", async () => {
  const { mod, dir } = await carregarJanela();
  try {
    const a = mod.offsetDoDia("2026-10-24");
    const b = mod.offsetDoDia("2026-10-24");
    assert.equal(a, b, "mesma data deve dar o mesmo offset");
    assert.ok(a >= -10 && a <= 10, "offset deve estar em [-10,+10]");
    assert.notEqual(mod.offsetDoDia("2026-10-25"), a === 0 ? -1 : a, "dias diferentes podem variar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("janela: offset persistido sobrevive a restart (mesmo data dir)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-janela-"));
  process.env.ALCANCE_DATA_DIR = dir;
  try {
    const m1 = await import(`./janela.js?v=${Math.random()}`);
    const v1 = m1.offsetDoDiaPersistido("2026-10-24");
    const raw = JSON.parse(readFileSync(join(dir, "monitor-janela.json"), "utf8"));
    assert.equal(raw.offsets["2026-10-24"], v1, "primeiro acesso grava o offset do dia");
    const m2 = await import(`./janela.js?v=${Math.random()}`);
    assert.equal(m2.offsetDoDiaPersistido("2026-10-24"), v1, "restart deve ler o mesmo valor");
    assert.equal(m2.offsetDoDiaPersistido("2026-10-24"), v1, "restart deve ler o mesmo valor");
  } finally {
    delete process.env.ALCANCE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("janela: 12h (meio-dia) está aberta, 3h está fechada", async () => {
  const { mod, dir } = await carregarJanela();
  try {
    const meioDia = new Date("2026-10-24T15:00:00Z"); // 12:00 em America/Sao_Paulo
    const madrugada = new Date("2026-10-24T06:00:00Z"); // 03:00 em America/Sao_Paulo
    assert.equal(mod.estadoJanela(meioDia).aberta, true);
    assert.equal(mod.estadoJanela(madrugada).aberta, false);
    assert.equal(mod.estadoJanela(madrugada).reabreAs, mod.estadoJanela(madrugada).abre);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("janela: bordas respeitam o offset do dia (08:00-10 abre 07:50)", async () => {
  const { mod, dir } = await carregarJanela();
  try {
    // offset do dia 2026-10-24
    const off = mod.offsetDoDiaPersistido("2026-10-24");
    const dentro = new Date(`2026-10-24T${String(8).padStart(2,"0")}:00:00-03:00`); // 08:00 local
    // se offset negativo (abre 07:50), 08:00 está dentro; se positivo (abre 08:10), ainda fechada
    const esperado = off <= 0 ? true : false;
    assert.equal(mod.estadoJanela(dentro).aberta, esperado);
    // 23:00 local com offset: fechada se offset<0 (fechou antes), aberta se offset>=0? fecha em 23:00+off (exclusivo)
    const fecha = new Date(`2026-10-24T23:00:00-03:00`); // 23:00 local
    const esperadoF = off > 0; // fecha = 23:00+off; 23:00 ainda está dentro iff off>0
    assert.equal(mod.estadoJanela(fecha).aberta, esperadoF);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
