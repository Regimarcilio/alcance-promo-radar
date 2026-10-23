/**
 * Rotação de números: anti-repetição, todos os abertos no envio e dedup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Ambiente de rotação: 3 números ativos (1 marcado como principal).
 * O estado de conexão é "erro" (Evolution fora) → o sorteio cai nos ATIVOS.
 */
async function carregarRotacao(repeticao = "1", itens?: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-rot-"));
  writeFileSync(
    join(dir, "instancias.json"),
    JSON.stringify({
      itens:
        itens ?? [
          { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
          { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
          { instancia: "cel-3", nome: "Celular 3", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
        ],
    }),
  );
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.RODIZIO_EVITA_REPETICAO = repeticao;
  process.env.EVO_URL = "http://evo.test";
  const mod = await import(`./rotacao.js?v=${Math.random()}`);
  return { mod, dir };
}

test("rotação: com 3 números, nunca repete o anterior (anti-repetição 100%)", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    const vistos = new Set<string>();
    let anterior: string | null = null;
    for (let i = 0; i < 30; i++) {
      const atual = await mod.proximaInstancia();
      if (anterior) assert.notEqual(atual, anterior, "não deveria repetir o mesmo número em sequência");
      vistos.add(atual);
      anterior = atual;
    }
    assert.equal(vistos.size, 3, "os três números devem entrar no rodízio");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotação: sem anti-repetição (0) pode repetir — sorteio puro por peso", async () => {
  const { mod, dir } = await carregarRotacao("0");
  try {
    const sorteios = new Set<string>();
    for (let i = 0; i < 60; i++) sorteios.add(await mod.proximaInstancia());
    assert.equal(sorteios.size, 3, "com 3 números os três devem aparecer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotação: registra a última usada para a UI", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    const a = await mod.proximaInstancia();
    assert.equal(mod.ultimaInstanciaUsada(), a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- política de envio × serviço --------------------------- */

test("principal: é a marcada; senão a que casa com EVO_INSTANCE", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    assert.equal(mod.instanciaPrincipal()?.instancia, "cel-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("envio de mensagens: usa todos os abertos, inclusive o principal", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    const vistos = new Set<string>();
    for (let i = 0; i < 60; i++) vistos.add(await mod.proximaInstancia());
    assert.deepEqual([...vistos].sort(), ["cel-1", "cel-2", "cel-3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sem outro número disponível: o envio usa o principal (nada para)", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
  ]);
  try {
    assert.equal(await mod.proximaInstancia(), "cel-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operação de serviço: sempre no principal", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    assert.equal(await mod.instanciaParaServico(), "cel-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("definirPrincipal: só um por vez", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    mod.definirPrincipal("cel-2", true);
    assert.equal(mod.instanciaPrincipal()?.instancia, "cel-2");
    const itens = mod.listarInstancias();
    assert.equal(itens.filter((i: { principal?: boolean }) => i.principal).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ dedup ------------------------------------ */

async function carregarEstado(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-dedup-"));
  process.env.ALCANCE_DATA_DIR = dir;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import(`../monitor/state.js?v=${Math.random()}`);
  return { mod, dir };
}

test("dedup: mesmo produto de ORIGENS diferentes passa (DEDUP_POR_ORIGEM=1)", async () => {
  const { mod, dir } = await carregarEstado({ DEDUP_POR_ORIGEM: "1", DEDUP_DIAS: "7" });
  try {
    mod.marcarMonitorado("mercadolivre", "MLB123", "https://x", "origemA");
    assert.equal(mod.jaMonitorado("mercadolivre", "MLB123", "https://x", "origemA"), true);
    assert.equal(mod.jaMonitorado("mercadolivre", "MLB123", "https://x", "origemB"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedup: global (padrão) bloqueia o mesmo produto de qualquer origem", async () => {
  const { mod, dir } = await carregarEstado({ DEDUP_POR_ORIGEM: "0", DEDUP_DIAS: "7" });
  try {
    mod.marcarMonitorado("mercadolivre", "MLB123", "https://x", "origemA");
    assert.equal(mod.jaMonitorado("mercadolivre", "MLB123", "https://x", "origemB"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedup: janela em dias configurável (DEDUP_DIAS)", async () => {
  const { mod, dir } = await carregarEstado({ DEDUP_POR_ORIGEM: "0", DEDUP_DIAS: "1" });
  try {
    assert.equal(mod.diasDedup(), 1);
    mod.marcarMonitorado("mercadolivre", "MLB999", "https://y", "origemA");
    const fs = await import("node:fs");
    const f = join(dir, "monitor-estado.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const h = Object.keys(j.hashes)[0];
    j.hashes[h] = new Date(Date.now() - 3 * 86400000).toISOString();
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    assert.equal(mod.jaMonitorado("mercadolivre", "MLB999", "https://y", "origemA"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
