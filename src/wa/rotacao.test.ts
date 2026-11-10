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

test("serviço: principal primeiro, depois as ativas por peso (inativas ficam fora)", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "off", nome: "Desligada", ativo: false, peso: 10, enviadas: 0, ultimaEm: null, criadaEm: "" },
    { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 7, enviadas: 0, ultimaEm: null, criadaEm: "" },
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 1, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
    { instancia: "cel-3", nome: "Celular 3", ativo: true, peso: 3, enviadas: 0, ultimaEm: null, criadaEm: "" },
  ]);
  try {
    assert.deepEqual(await mod.instanciasParaServico(), ["cel-1", "cel-2", "cel-3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serviço: sem nenhuma ativa, cai na principal (não devolve lista vazia)", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: false, peso: 5, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
  ]);
  try {
    assert.deepEqual(await mod.instanciasParaServico(), ["cel-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serviço: instância marcada como ruim vai para o fim da lista", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 1, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
    { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
    { instancia: "cel-3", nome: "Celular 3", ativo: true, peso: 3, enviadas: 0, ultimaEm: null, criadaEm: "" },
  ]);
  try {
    assert.deepEqual(await mod.instanciasParaServico(), ["cel-1", "cel-2", "cel-3"]);
    mod.marcarInstanciaRuim("cel-1");
    assert.equal(mod.instanciaRuim("cel-1"), true);
    assert.deepEqual(await mod.instanciasParaServico(), ["cel-2", "cel-3", "cel-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("envio: instância marcada como ruim não é sorteada", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
    { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
  ]);
  try {
    mod.marcarInstanciaRuim("cel-1");
    for (let i = 0; i < 25; i++) assert.equal(await mod.proximaInstancia(), "cel-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------- permissões por número / pausa (issue #36) ---------------- */

const ITENS_PERM = [
  { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: false, monitor: true, disparo: false } },
  { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: true, monitor: false, disparo: true } },
  { instancia: "cel-3", nome: "Celular 3", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: true, monitor: true, disparo: false } },
];

test("permissões: fluxo de disparo nunca sorteia número sem permissão", async () => {
  const { mod, dir } = await carregarRotacao("0", ITENS_PERM);
  try {
    for (let i = 0; i < 25; i++) assert.equal(await mod.proximaInstancia("disparo"), "cel-2");
    for (let i = 0; i < 25; i++) assert.notEqual(await mod.proximaInstancia("monitor"), "cel-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permissões: nenhum número permitido no fluxo → erro claro, sem sortear proibido", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: true, monitor: true, disparo: false } },
  ]);
  try {
    await assert.rejects(
      () => mod.proximaInstancia("disparo"),
      /Nenhum número ativo e permitido para o fluxo "disparo"/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pausa: número pausado sai de TODOS os fluxos (inclusive chamada sem fluxo)", async () => {
  const { mod, dir } = await carregarRotacao("0", ITENS_PERM.map((i) => ({ ...i, pausado: i.instancia === "cel-1" })));
  try {
    for (let n = 0; n < 25; n++) assert.notEqual(await mod.proximaInstancia(), "cel-1");
    for (let n = 0; n < 25; n++) assert.notEqual(await mod.proximaInstancia("monitor"), "cel-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pausa: todos pausados → erro no fluxo (não envia com número proibido)", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: true, monitor: true, disparo: true }, pausado: true },
  ]);
  try {
    await assert.rejects(() => mod.proximaInstancia("piloto"), /Nenhum número ativo e permitido/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("definirPermissoes/definirPausado: persistem e valem no sorteio", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 1, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: true, monitor: true, disparo: true } },
    { instancia: "cel-2", nome: "Celular 2", ativo: true, peso: 1, enviadas: 0, ultimaEm: null, criadaEm: "", permissoes: { piloto: true, monitor: true, disparo: true } },
  ]);
  try {
    mod.definirPermissoes("cel-1", { disparo: false });
    mod.definirPausado("cel-2", true);
    const porNome = Object.fromEntries(mod.listarInstancias().map((i: any) => [i.instancia, i]));
    assert.deepEqual(porNome["cel-1"].permissoes, { piloto: true, monitor: true, disparo: false });
    assert.equal(porNome["cel-2"].pausado, true);
    // cel-1 segue permitido no piloto; cel-2 pausado sai de tudo
    for (let n = 0; n < 20; n++) assert.equal(await mod.proximaInstancia("piloto"), "cel-1");
    // disparo: cel-1 sem permissão e cel-2 pausado → nenhum permitido
    await assert.rejects(() => mod.proximaInstancia("disparo"), /Nenhum número ativo e permitido/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migração: instância antiga ganha as 3 permissões ligadas e pausado=false", async () => {
  const { mod, dir } = await carregarRotacao("1", [
    { instancia: "cel-1", nome: "Celular 1", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
  ]);
  try {
    const i = mod.listarInstancias()[0];
    assert.deepEqual(i.permissoes, { piloto: true, monitor: true, disparo: true });
    assert.equal(i.pausado, false);
    assert.equal(await mod.proximaInstancia("monitor"), "cel-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------- override manual por fluxo (issue #37) ------------- */

const ITENS_TODOS = ITENS_PERM.map((i) => ({
  ...i,
  permissoes: { piloto: true, monitor: true, disparo: true },
}));

const mockOpen = async () => {
  const { mockFetch } = await import("../monitor/test-utils.js");
  return mockFetch(async () =>
    new Response(JSON.stringify({ instance: { state: "open" } }), {
      headers: { "content-type": "application/json" },
    })
  );
};

test("override: fixa o celular no fluxo (monitor sempre em cel-2)", async () => {
  const { mod, dir } = await carregarRotacao("0", ITENS_TODOS);
  const m = await mockOpen();
  try {
    mod.definirOverride("cel-2", "monitor", "cel-2");
    for (let i = 0; i < 20; i++) assert.equal(await mod.proximaInstancia("monitor"), "cel-2");
    // persistiu no arquivo e o GET reflete
    assert.equal(mod.overrideDoFluxo("monitor"), "cel-2");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("override: inválido (pausado) cai no automático e registra aviso", async () => {
  const { mod, dir } = await carregarRotacao("0", ITENS_TODOS);
  const m = await mockOpen();
  const logs: string[] = [];
  const original = console.log;
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  try {
    mod.definirOverride("cel-2", "monitor", "cel-2");
    mod.definirPausado("cel-2", true);
    for (let i = 0; i < 20; i++) assert.notEqual(await mod.proximaInstancia("monitor"), "cel-2");
    assert.ok(logs.some((l) => /override cel-2 inválido para fluxo monitor/.test(l)), "deve avisar no log");
  } finally {
    console.log = original;
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("override: limpar volta ao sorteio automático", async () => {
  const { mod, dir } = await carregarRotacao("0", ITENS_TODOS);
  const m = await mockOpen();
  try {
    mod.definirOverride("cel-2", "monitor", "cel-2");
    assert.equal(await mod.proximaInstancia("monitor"), "cel-2");
    mod.definirOverride("cel-2", "monitor", null);
    assert.equal(mod.overrideDoFluxo("monitor"), null);
    const vistos = new Set<string>();
    for (let i = 0; i < 40; i++) vistos.add(await mod.proximaInstancia("monitor"));
    assert.ok(vistos.size >= 2, "sem override deve sortear entre os permitidos");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("override: é isolado por fluxo (piloto fixo não afeta monitor)", async () => {
  const { mod, dir } = await carregarRotacao("0", ITENS_TODOS);
  const m = await mockOpen();
  try {
    mod.definirOverride("cel-2", "piloto", "cel-2");
    for (let i = 0; i < 15; i++) assert.equal(await mod.proximaInstancia("piloto"), "cel-2");
    const vistos = new Set<string>();
    for (let i = 0; i < 40; i++) vistos.add(await mod.proximaInstancia("monitor"));
    assert.ok(vistos.has("cel-1") || vistos.has("cel-3"), "monitor deve seguir o automático");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("override: definirOverride em fluxo inválido lança erro", async () => {
  const { mod, dir } = await carregarRotacao("1", ITENS_TODOS);
  try {
    assert.throws(() => mod.definirOverride("cel-1", "outro" as any, "cel-1"), /fluxo inválido/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
