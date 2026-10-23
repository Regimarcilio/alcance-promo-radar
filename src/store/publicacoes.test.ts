/** Testes do log de publicações (base do Rastreio). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function carregar() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-pub-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./publicacoes.js?v=${Math.random()}`);
  return { mod, dir };
}

const P = {
  em: new Date().toISOString(),
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

test("registra e lista publicações", async () => {
  const { mod, dir } = await carregar();
  try {
    mod.registrarPublicacao(P);
    mod.registrarPublicacao({ ...P, via: "monitor", programa: "ml", categoria: "MLB3937" });
    const lista = mod.listarPublicacoes({});
    assert.equal(lista.length, 2);
    // mais recentes primeiro
    assert.equal(lista[0].via, "monitor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filtros: por programa, categoria, via e período", async () => {
  const { mod, dir } = await carregar();
  try {
    mod.registrarPublicacao(P);
    mod.registrarPublicacao({ ...P, via: "monitor", programa: "ml", categoria: "MLB3937" });
    assert.equal(mod.listarPublicacoes({ programa: "amazon" }).length, 1);
    assert.equal(mod.listarPublicacoes({ categoria: "MLB3937" }).length, 1);
    assert.equal(mod.listarPublicacoes({ via: "piloto" }).length, 1);
    assert.equal(mod.listarPublicacoes({ dias: 1 }).length, 2);
    assert.equal(mod.listarPublicacoes({ dias: 1, programa: "ml" }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumo: conta por programa e quantos têm tag", async () => {
  const { mod, dir } = await carregar();
  try {
    mod.registrarPublicacao(P);
    mod.registrarPublicacao({ ...P, via: "monitor", programa: "ml", tag: undefined });
    const r = mod.resumoRastreio({});
    assert.equal(r.total, 2);
    assert.equal(r.porPrograma.amazon, 1);
    assert.equal(r.porPrograma.ml, 1);
    assert.equal(r.comTag, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSV: cabeçalho + uma linha por publicação", async () => {
  const { mod, dir } = await carregar();
  try {
    mod.registrarPublicacao(P);
    const csv = mod.publicacoesCsv({});
    const linhas = csv.split("\n");
    assert.match(linhas[0], /^data;programa;categoria;grupo;id;titulo;preco;tag;via;link$/);
    assert.equal(linhas.length, 2);
    assert.match(linhas[1], /B0DWGWN8GY/);
    assert.match(linhas[1], /joias-20/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSV: neutraliza formula injection em campos livres", async () => {
  const { mod, dir } = await carregar();
  try {
    mod.registrarPublicacao({ ...P, titulo: "=HYPERLINK(\"http://evil\")", tag: "@cmd" });
    const csv = mod.publicacoesCsv({});
    assert.match(csv, /"'=HYPERLINK/);
    assert.match(csv, /"'@cmd"/);
    assert.doesNotMatch(csv, /;"=HYPERLINK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
