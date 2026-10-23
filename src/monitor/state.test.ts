/**
 * Testes do limite de eventos do estado do monitor (MONITOR_EVENTOS_LIMITE).
 * Cada caso reimporta o módulo com um env diferente (cache-bust via query).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function carregarCom(limite: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-estado-"));
  process.env.ALCANCE_DATA_DIR = dir;
  if (limite === null) delete process.env.MONITOR_EVENTOS_LIMITE;
  else process.env.MONITOR_EVENTOS_LIMITE = limite;
  // query string = nova instância do módulo (env avaliado no import)
  const mod = await import(`./state.js?v=${Math.random()}`);
  return { mod, dir };
}

function evento(n: number) {
  return {
    em: new Date().toISOString(),
    origem: "5511999999999@g.us",
    programa: "shopee",
    idProduto: String(n),
    linkTransformado: `https://shope.ee/x${n}`,
    destino: null,
    status: "REVISAO" as const,
  };
}

test("MONITOR_EVENTOS_LIMITE=3: mantém só os 3 últimos eventos", async () => {
  const { mod, dir } = await carregarCom("3");
  try {
    for (let i = 1; i <= 6; i++) mod.registrarEvento(evento(i));
    const s = JSON.parse(readFileSync(join(dir, "monitor-estado.json"), "utf8"));
    assert.equal(s.eventos.length, 3);
    // os 3 mais recentes permanecem
    assert.deepEqual(
      s.eventos.map((e: { idProduto: string }) => e.idProduto),
      ["4", "5", "6"],
    );
    // contador vitalício: 6 recebidas mesmo com buffer de 3 eventos
    assert.equal(mod.resumo().recebidas, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MONITOR_EVENTOS_LIMITE=0: ilimitado (contador não trava)", async () => {
  const { mod, dir } = await carregarCom("0");
  try {
    for (let i = 1; i <= 620; i++) mod.registrarEvento(evento(i));
    const s = JSON.parse(readFileSync(join(dir, "monitor-estado.json"), "utf8"));
    assert.equal(s.eventos.length, 620);
    assert.equal(mod.resumo().recebidas, 620);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sem MONITOR_EVENTOS_LIMITE: padrão 500", async () => {
  const { mod, dir } = await carregarCom(null);
  try {
    for (let i = 1; i <= 505; i++) mod.registrarEvento(evento(i));
    const s = JSON.parse(readFileSync(join(dir, "monitor-estado.json"), "utf8"));
    assert.equal(s.eventos.length, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserva atômica: mesma oferta só passa uma vez e liberar devolve", async () => {
  const { mod, dir } = await carregarCom(null);
  try {
    assert.equal(mod.reservarMonitorado("shopee", "SKU1", "https://x"), true);
    assert.equal(mod.reservarMonitorado("shopee", "SKU1", "https://x"), false);
    assert.equal(mod.totalHashes(), 1);
    mod.liberarReserva("shopee", "SKU1", "https://x");
    assert.equal(mod.totalHashes(), 0);
    assert.equal(mod.reservarMonitorado("shopee", "SKU1", "https://x"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedup expirado é podado na gravação (DEDUP_DIAS=1)", async () => {
  const { mod, dir } = await carregarCom(null);
  try {
    process.env.DEDUP_DIAS = "1";
    const h = mod.hashMonitor("shopee", "VELHO", "https://x");
    const antigo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "monitor-estado.json"),
      JSON.stringify({ hashes: { [h]: antigo }, eventos: [], totais: {} }),
    );
    assert.equal(mod.totalHashes(), 1, "hash antigo ainda é lido");
    mod.registrarEvento(evento(1));
    assert.equal(mod.totalHashes(), 0, "gravação poda hash fora da janela");
  } finally {
    delete process.env.DEDUP_DIAS;
    rmSync(dir, { recursive: true, force: true });
  }
});
