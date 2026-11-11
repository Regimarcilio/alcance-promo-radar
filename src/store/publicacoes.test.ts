/** Testes do log de publicações (base do Rastreio). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function carregar(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-pub-"));
  process.env.ALCANCE_DATA_DIR = dir;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

/* ------------- total histórico + limite configurável (issue #38) ------------- */

/** Escreve N publicações direto no arquivo (simula histórico já existente). */
function gravarHistorico(dir: string, n: number): void {
  const arr = Array.from({ length: n }, (_, i) => ({ ...P, id: `B0HIST${i}`, titulo: `Item ${i}` }));
  writeFileSync(join(dir, "publicacoes.json"), JSON.stringify(arr));
}

test("total histórico: contador não trava no limite do arquivo", async () => {
  const { mod, dir } = await carregar({ RASTREIO_LIMITE: "1000" });
  try {
    gravarHistorico(dir, 1000);
    // migração: meta ausente → inicializa com o tamanho atual
    assert.equal(mod.resumoRastreio().total, 1000);
    mod.registrarPublicacao(P);
    const r = mod.resumoRastreio();
    assert.equal(r.total, 1001, "total real deve passar de 1000");
    assert.equal(r.armazenados, 1000, "arquivo mantém o teto");
    assert.equal(r.limite, 1000);
    const meta = JSON.parse(readFileSync(join(dir, "rastreio-total.json"), "utf8"));
    assert.equal(meta.total, 1001);
  } finally {
    delete process.env.RASTREIO_LIMITE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limite configurável: RASTREIO_LIMITE mantém os últimos N", async () => {
  const { mod, dir } = await carregar({ RASTREIO_LIMITE: "1200" });
  try {
    gravarHistorico(dir, 1200);
    for (let i = 0; i < 5; i++) mod.registrarPublicacao({ ...P, id: `NOVO${i}` });
    const r = mod.resumoRastreio();
    assert.equal(r.limite, 1200);
    assert.equal(r.armazenados, 1200);
    assert.equal(r.total, 1205, "total histórico continua crescendo");
    const arr = JSON.parse(readFileSync(join(dir, "publicacoes.json"), "utf8"));
    assert.equal(arr.length, 1200);
    assert.equal(arr[arr.length - 1].id, "NOVO4", "mantém os últimos registros");
  } finally {
    delete process.env.RASTREIO_LIMITE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migração: total histórico inicia no tamanho atual e nunca diminui", async () => {
  const { mod, dir } = await carregar({ RASTREIO_LIMITE: undefined });
  try {
    gravarHistorico(dir, 5);
    assert.equal(mod.resumoRastreio().total, 5);
    mod.registrarPublicacao(P);
    assert.equal(mod.resumoRastreio().total, 6);
    mod.registrarPublicacao({ ...P, id: "MAIS1" });
    assert.equal(mod.resumoRastreio().total, 7);
    const meta = JSON.parse(readFileSync(join(dir, "rastreio-total.json"), "utf8"));
    assert.equal(meta.total, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limite tem piso de segurança de 1000", async () => {
  const { mod, dir } = await carregar({ RASTREIO_LIMITE: "10" });
  try {
    assert.equal(mod.limitePublicacoes(), 1000);
  } finally {
    delete process.env.RASTREIO_LIMITE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filtros continuam valendo sobre o que está armazenado", async () => {
  const { mod, dir } = await carregar({ RASTREIO_LIMITE: "1000" });
  try {
    gravarHistorico(dir, 999);
    mod.registrarPublicacao({ ...P, programa: "ml", categoria: "MLB3937", via: "monitor" });
    const amz = mod.resumoRastreio({ programa: "amazon" });
    assert.equal(amz.porPrograma.amazon, 999);
    const csv = mod.publicacoesCsv({ programa: "amazon" });
    assert.equal(csv.split("\n").length, 1000); // cabeçalho + 999
  } finally {
    delete process.env.RASTREIO_LIMITE;
    rmSync(dir, { recursive: true, force: true });
  }
});
