/**
 * Testes do RASTREIO no SQLite (Fase 2 do ADR-012).
 *
 * O contrato testado aqui é o caminho normal: banco ligado, migração do
 * `publicacoes.json` uma única vez, escrita incremental e leitura filtrada.
 * A degradação para JSON vive em `publicacoes.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = {
  em: "2026-11-17T10:00:00.000Z",
  programa: "amazon" as const,
  categoria: "AMJOIA",
  grupo: "120363@g.us",
  id: "B0DWGWN8GY",
  titulo: "Relógio de ouro",
  preco: 199.9,
  link: "https://www.amazon.com.br/dp/B0DWGWN8GY?tag=joias-20",
  tag: "joias-20",
  via: "piloto" as const,
};

async function carregar(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-pubdb-"));
  process.env.ALCANCE_DATA_DIR = dir;
  delete process.env.CATALOGO_BD; // banco ligado = caminho normal
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { fecharBanco } = await import("./db.js");
  fecharBanco();
  const mod = await import(`./publicacoes.js?v=${Math.random()}`);
  return { mod, dir };
}

/** Simula histórico pré-migração gravando o JSON legado. */
function gravarJson(dir: string, n: number): void {
  const arr = Array.from({ length: n }, (_, i) => ({ ...P, id: `B0HIST${i}`, titulo: `Item ${i}` }));
  writeFileSync(join(dir, "publicacoes.json"), JSON.stringify(arr));
}

test("migra o publicacoes.json para o banco preservando os campos", async () => {
  const { mod, dir } = await carregar();
  try {
    gravarJson(dir, 3);
    const r = mod.prepararRastreio();
    assert.equal(r.migrado, true, "migração roda na primeira chamada");
    assert.equal(r.armazenados, 3);
    assert.equal(r.total, 3, "contador semeia com o histórico existente");

    const lista = mod.listarPublicacoes({});
    assert.equal(lista.length, 3);
    const um = lista.find((p: { id: string }) => p.id === "B0HIST1");
    assert.equal(um.grupo, P.grupo);
    assert.equal(um.preco, 199.9);
    assert.equal(um.tag, "joias-20");
    assert.equal(um.link, P.link);
    assert.equal(um.via, "piloto");
    assert.equal(um.categoria, "AMJOIA");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migração é idempotente (rodar de novo não duplica)", async () => {
  const { mod, dir } = await carregar();
  try {
    gravarJson(dir, 4);
    assert.equal(mod.prepararRastreio().armazenados, 4);
    // apaga a marca: força a migração a rodar outra vez sobre o mesmo JSON
    const { banco } = await import("./db.js");
    banco()!.prepare("DELETE FROM schema_meta WHERE chave = 'rastreio_migrado'").run();
    const mod2 = await import(`./publicacoes.js?v=${Math.random()}`);
    assert.equal(mod2.prepararRastreio().armazenados, 4, "INSERT OR IGNORE + chave UNIQUE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escrita no banco não reescreve o publicacoes.json", async () => {
  const { mod, dir } = await carregar();
  try {
    gravarJson(dir, 2);
    mod.registrarPublicacao(P);
    mod.registrarPublicacao({ ...P, id: "NOVO1" });
    // o JSON é snapshot da migração: fica congelado (é o ganho de performance)
    const arr = JSON.parse(readFileSync(join(dir, "publicacoes.json"), "utf8"));
    assert.equal(arr.length, 2);
    assert.equal(mod.resumoRastreio().armazenados, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lista, filtra e resume a partir do banco", async () => {
  const { mod, dir } = await carregar();
  try {
    mod.registrarPublicacao(P);
    mod.registrarPublicacao({
      ...P,
      em: "2026-11-17T11:00:00.000Z",
      programa: "ml",
      categoria: "MLB3937",
      via: "monitor",
      tag: undefined,
    });
    assert.equal(mod.listarPublicacoes({}).length, 2);
    assert.equal(mod.listarPublicacoes({}).at(0).programa, "ml", "mais recente primeiro");
    assert.equal(mod.listarPublicacoes({ programa: "amazon" }).length, 1);
    assert.equal(mod.listarPublicacoes({ categoria: "MLB3937" }).length, 1);
    assert.equal(mod.listarPublicacoes({ via: "piloto" }).length, 1);
    assert.equal(mod.listarPublicacoes({ dias: 1 }).length, 2);
    assert.equal(mod.listarPublicacoes({ dias: 1, programa: "ml" }).length, 1);

    const r = mod.resumoRastreio({});
    assert.equal(r.total, 2);
    assert.equal(r.armazenados, 2);
    assert.equal(r.porPrograma.amazon, 1);
    assert.equal(r.porPrograma.ml, 1);
    assert.equal(r.comTag, 1);

    const csv = mod.publicacoesCsv({ programa: "amazon" });
    assert.equal(csv.split("\n").length, 2);
    assert.match(csv, /B0DWGWN8GY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retém apenas os últimos N no banco (RASTREIO_LIMITE)", async () => {
  const { mod, dir } = await carregar({ RASTREIO_LIMITE: "1000" });
  try {
    gravarJson(dir, 1000);
    for (let i = 0; i < 5; i++) mod.registrarPublicacao({ ...P, id: `NOVO${i}` });
    const r = mod.resumoRastreio();
    assert.equal(r.limite, 1000);
    assert.equal(r.armazenados, 1000, "teto respeitado");
    assert.equal(r.total, 1005, "total histórico continua crescendo");
    assert.equal(mod.listarPublicacoes({ limite: 1 }).at(0).id, "NOVO4", "mantém os últimos");
  } finally {
    delete process.env.RASTREIO_LIMITE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limite de linhas na leitura evita carregar o histórico inteiro", async () => {
  const { mod, dir } = await carregar();
  try {
    for (let i = 0; i < 10; i++) {
      mod.registrarPublicacao({ ...P, em: `2026-11-17T10:00:0${i}.000Z`, id: `I${i}` });
    }
    const top = mod.listarPublicacoes({ limite: 3 });
    assert.equal(top.length, 3);
    assert.deepEqual(
      top.map((p: { id: string }) => p.id),
      ["I9", "I8", "I7"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
