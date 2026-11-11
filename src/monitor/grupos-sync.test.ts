/**
 * Sincronização diária de grupos: adiciona apenas origens novas, atualiza
 * nomes e nunca transforma o destino em origem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function comStore(regras: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-sync-"));
  process.env.ALCANCE_DATA_DIR = dir;
  writeFileSync(
    join(dir, "monitor.json"),
    JSON.stringify({ regras, autoEnviar: true, foto: "origem", criadoEm: new Date().toISOString() }),
  );
  const mod = await import(`./grupos.js?v=${Math.random()}`);
  return { mod, dir };
}

const destino = { jid: "120363412937047408@g.us", nome: "Mano dos Achadinhos", ativo: true, criadoEm: "x" };
const origem = { jid: "120363429892871960@g.us", nome: "Antigo", ativo: true, criadoEm: "x" };

test("sync adiciona grupos novos, atualiza nome e ignora o destino", async () => {
  const { mod, dir } = await comStore([{ origem, destinos: [destino], criadoEm: "x" }]);
  try {
    const r = mod.sincronizarOrigens([
      { jid: origem.jid, nome: "Epipe novo" },
      { jid: destino.jid, nome: "Mano dos Achadinhos" },
      { jid: "120363409461232125@g.us", nome: "Leleco Tech" },
    ], { autoAdicionar: true });
    assert.deepEqual(r.adicionados, ["120363409461232125@g.us"]);
    assert.deepEqual(r.atualizados, [origem.jid]);
    assert.ok(r.ignorados.includes(destino.jid));
    const salvo = JSON.parse(readFileSync(join(dir, "monitor.json"), "utf8"));
    assert.equal(salvo.regras.length, 2);
    assert.equal(salvo.regras[0].origem.nome, "Epipe novo");
    assert.equal(salvo.regras[1].destinos[0].jid, destino.jid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync com autoAdicionar=false só atualiza metadados", async () => {
  const { mod, dir } = await comStore([{ origem, destinos: [destino], criadoEm: "x" }]);
  try {
    const r = mod.sincronizarOrigens(
      [{ jid: "120363409461232125@g.us", nome: "Leleco Tech" }],
      { autoAdicionar: false },
    );
    assert.equal(r.adicionados.length, 0);
    assert.ok(r.ignorados.includes("120363409461232125@g.us"));
    const salvo = JSON.parse(readFileSync(join(dir, "monitor.json"), "utf8"));
    assert.equal(salvo.regras.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
