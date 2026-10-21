/** Teste do PILOTO_AUTORELIGA: após reinício, o loop volta a rodar. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = {
  id: 1,
  conta: "principal",
  category: "MLB1246",
  sub: "MLB6284",
  grupo: "120363411920451567@g.us",
  minMin: 5,
  maxMin: 5,
  rodando: true,
  iniciadaEm: new Date().toISOString(),
  ultimaMsg: null,
  proximaEm: null,
  enviadas: 7,
  cicloInicio: null,
  qtd: 1,
  intervaloS: 90,
  programa: "ml",
};

test("PILOTO_AUTORELIGA=1: loop que estava rodando volta a rodar após o boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-piloto-"));
  writeFileSync(join(dir, "piloto.json"), JSON.stringify({ loops: [LOOP], logs: [] }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.PILOTO_AUTORELIGA = "1";
  const mod = await import(`./piloto.js?v=${Math.random()}`);

  const status = mod.status();
  assert.equal(status.rodando, 1, "o loop deveria ter religado");
  assert.equal(status.loops[0].rodando, true);
  assert.match(status.logs.join("\n"), /religados automaticamente/);

  mod.stop(); // limpa os timers (senão o processo não sai)
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PILOTO_AUTORELIGA;
});

test("sem PILOTO_AUTORELIGA: reinício pausa tudo (comportamento seguro padrão)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-piloto-"));
  writeFileSync(join(dir, "piloto.json"), JSON.stringify({ loops: [LOOP], logs: [] }));
  process.env.ALCANCE_DATA_DIR = dir;
  delete process.env.PILOTO_AUTORELIGA;
  const mod = await import(`./piloto.js?v=${Math.random()}`);

  const status = mod.status();
  assert.equal(status.rodando, 0, "o loop deveria estar pausado");
  assert.equal(status.loops[0].rodando, false);
  // e a pausa é persistida (o arquivo não fica fingindo que está ligado)
  const salvo = JSON.parse(readFileSync(join(dir, "piloto.json"), "utf8"));
  assert.equal(salvo.loops[0].rodando, false);
  assert.match(status.logs.join("\n"), /pausado\(s\) após reinício/);

  mod.stop();
  rmSync(dir, { recursive: true, force: true });
});
