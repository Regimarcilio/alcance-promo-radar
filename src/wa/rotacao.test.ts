/** Testes da rotação de números (anti-repetição) e do dedup do monitor. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Instâncias de teste: 2 números ativos, mesmo peso. */
async function carregarRotacao(repeticao = "1") {
  const dir = mkdtempSync(join(tmpdir(), "alcance-rot-"));
  writeFileSync(
    join(dir, "instancias.json"),
    JSON.stringify({
      itens: [
        { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
        { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
      ],
    }),
  );
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.RODIZIO_EVITA_REPETICAO = repeticao;
  // estado fixo: os dois "open" (sem depender da Evolution)
  process.env.EVO_URL = "http://evo.test";
  const mod = await import(`./rotacao.js?v=${Math.random()}`);
  return { mod, dir };
}

test("rotação: com 2 números, nunca repete o anterior (anti-repetição 100%)", async () => {
  const { mod, dir } = await carregarRotacao("1");
  try {
    // o estado da conexão precisa ser "open": forçamos via env EVO_URL inválido
    // então usamos o fallback (ativos) — o sorteio ainda alterna.
    const a = await mod.proximaInstancia();
    const b = await mod.proximaInstancia();
    const c = await mod.proximaInstancia();
    assert.notEqual(a, b, "não deveria repetir o mesmo número em sequência");
    assert.notEqual(b, c, "não deveria repetir o mesmo número em sequência");
    assert.equal(a, c, "com 2 números deve alternar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotação: sem anti-repetição (0) pode repetir — sorteio puro por peso", async () => {
  const { mod, dir } = await carregarRotacao("0");
  try {
    const sorteios = new Set<string>();
    for (let i = 0; i < 40; i++) sorteios.add(await mod.proximaInstancia());
    assert.equal(sorteios.size, 2, "com 2 números ativos os dois devem aparecer");
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

/** Dedup do monitor: janela e escopo. */
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
    // mark now, and simulate an older timestamp by rewriting the hash store
    const fs = await import("node:fs");
    const f = join(dir, "monitor-estado.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const h = Object.keys(j.hashes)[0];
    j.hashes[h] = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 dias atrás
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    // com janela de 1 dia, um registro de 3 dias atrás já expirou
    assert.equal(mod.jaMonitorado("mercadolivre", "MLB999", "https://y", "origemA"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
