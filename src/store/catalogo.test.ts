/**
 * Catálogo de ofertas recebidas (ADR-012).
 *
 * O que estes testes travam:
 * - a oferta DESCARTADA (duplicada/sem link) também entra no histórico — é o
 *   ponto do ADR: hoje ela desaparece e não há como reenviar do passado;
 * - filtros (programa, origem, desfecho, faixa de preço, busca, período);
 * - paginação e resumo para os cards do painel;
 * - CSV com mesmo padrão do rastreio (inclusive anti-injeção de fórmula);
 * - retenção e limpeza;
 * - degradação segura: `CATALOGO_BD=0` e dados malformados nunca lançam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fecharBanco, bancoPath } from "./db.js";
import {
  registrarOferta,
  listarOfertas,
  resumoCatalogo,
  catalogoCsv,
  podarCatalogo,
  limparCatalogo,
} from "./catalogo.js";

/** Novo data dir por teste; `fecharBanco` força a reabrir no caminho novo. */
function novoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "alcance-catalogo-"));
  process.env.ALCANCE_DATA_DIR = dir;
  delete process.env.CATALOGO_BD;
  fecharBanco();
  return dir;
}

function encerrar(dir: string): void {
  fecharBanco();
  delete process.env.CATALOGO_BD;
  rmSync(dir, { recursive: true, force: true });
}

test("grava a oferta descartada com desfecho e motivo (o que hoje se perde)", () => {
  const dir = novoDir();
  try {
    const a = registrarOferta({
      origem: "grupo-a",
      programa: "ml",
      idProduto: "MLB1",
      titulo: "Fone Bluetooth",
      preco: 89.9,
      precoDe: 149.9,
      link: "https://mercadolivre.com/sec/abc",
      cupom: "PROMO10",
      texto: "Oferta",
      desfecho: "ENCAMINHADO",
    });
    const b = registrarOferta({
      origem: "grupo-a",
      programa: "ml",
      idProduto: "MLB2",
      titulo: "Capa de celular",
      preco: 19.9,
      link: "https://mercadolivre.com/sec/def",
      texto: "Oferta",
      desfecho: "DUPLICADO",
      motivo: "oferta já encaminhada",
    });
    assert.ok(a && b, "as duas ofertas recebem id");
    assert.ok(existsSync(bancoPath()), "o arquivo do banco é criado dentro de data/");

    assert.equal(listarOfertas().total, 2, "a descartada também entra no histórico");

    const dup = listarOfertas({ desfecho: "DUPLICADO" });
    assert.equal(dup.total, 1);
    assert.equal(dup.itens[0].idProduto, "MLB2");
    assert.equal(dup.itens[0].motivo, "oferta já encaminhada");
    assert.equal(dup.itens[0].preco, 19.9);
    assert.equal(dup.itens[0].precoDe, null);
    const enc = listarOfertas({ desfecho: "ENCAMINHADO" }).itens[0];
    assert.equal(enc.cupom, "PROMO10");
    assert.equal(enc.precoDe, 149.9);
    assert.equal(enc.temMidia, false);
  } finally {
    encerrar(dir);
  }
});

test("filtros: programa, origem, faixa de preço, busca e período", () => {
  const dir = novoDir();
  try {
    registrarOferta({ origem: "g1", programa: "ml", titulo: "Smart TV 55", preco: 1999, link: "https://ml/1", desfecho: "ENCAMINHADO" });
    registrarOferta({ origem: "g1", programa: "amazon", titulo: "Panela antiaderente", preco: 79.9, link: "https://amz/2", desfecho: "ENCAMINHADO" });
    registrarOferta({ origem: "g2", programa: "ml", titulo: "Cabo HDMI", preco: 25, link: "https://ml/3", desfecho: "REVISAO", motivo: "link não reconhecido" });

    assert.equal(listarOfertas({ programa: "ml" }).total, 2);
    assert.equal(listarOfertas({ origem: "g2" }).total, 1);
    assert.equal(listarOfertas({ precoMin: 80, precoMax: 2000 }).total, 1);
    assert.equal(listarOfertas({ precoMax: 80 }).total, 2);
    assert.equal(listarOfertas({ busca: "hdmi" }).total, 1, "busca é case-insensitive");
    assert.equal(listarOfertas({ busca: "amz" }).total, 1, "busca cobre o link");
    assert.equal(listarOfertas({ dias: 1 }).total, 3, "todas são de agora");
  } finally {
    encerrar(dir);
  }
});

test("paginação devolve itens recentes primeiro e respeita o teto", () => {
  const dir = novoDir();
  try {
    for (let i = 0; i < 12; i++) {
      registrarOferta({
        origem: "g1",
        programa: "ml",
        titulo: `Produto ${i}`,
        preco: i + 1,
        desfecho: "ENCAMINHADO",
        recebidaEm: new Date(Date.now() - i * 60_000).toISOString(),
      });
    }
    const p1 = listarOfertas({ porPagina: 5, pagina: 1 });
    const p3 = listarOfertas({ porPagina: 5, pagina: 3 });
    assert.equal(p1.total, 12);
    assert.equal(p1.itens.length, 5);
    assert.equal(p1.itens[0].titulo, "Produto 0", "mais recente primeiro");
    assert.equal(p3.itens.length, 2);
    assert.equal(listarOfertas({ porPagina: 99_999 }).porPagina, 500, "teto duro de 500");
  } finally {
    encerrar(dir);
  }
});

test("resumo quebra por desfecho, programa e origem", () => {
  const dir = novoDir();
  try {
    registrarOferta({ origem: "g1", programa: "ml", desfecho: "ENCAMINHADO" });
    registrarOferta({ origem: "g1", programa: "ml", desfecho: "DUPLICADO" });
    registrarOferta({ origem: "g2", programa: "amazon", desfecho: "DUPLICADO" });
    const r = resumoCatalogo();
    assert.equal(r.total, 3);
    assert.equal(r.porDesfecho.ENCAMINHADO, 1);
    assert.equal(r.porDesfecho.DUPLICADO, 2);
    assert.equal(r.porPrograma.ml, 2);
    assert.equal(r.porPrograma.amazon, 1);
    assert.equal(r.porOrigem.g2, 1);
  } finally {
    encerrar(dir);
  }
});

test("CSV usa ';' e neutraliza injeção de fórmula", () => {
  const dir = novoDir();
  try {
    registrarOferta({
      origem: "g1",
      programa: "ml",
      titulo: "=cmd|' /C calc'!A0",
      preco: 10,
      link: "https://ml/1",
      desfecho: "ENCAMINHADO",
    });
    const csv = catalogoCsv();
    const linhas = csv.split("\n");
    assert.match(linhas[0], /^data;origem;programa;id;titulo;preco;preco_de;link;cupom;desfecho;motivo$/);
    assert.equal(linhas.length, 2);
    assert.ok(linhas[1].includes(`"'=cmd|' /C calc'!A0"`), "fórmula recebe apóstrofo e aspas");
  } finally {
    encerrar(dir);
  }
});

test("retenção apaga só o que passou da janela", () => {
  const dir = novoDir();
  try {
    const velho = new Date(Date.now() - 40 * 86_400_000).toISOString();
    registrarOferta({ origem: "g1", desfecho: "ENCAMINHADO", recebidaEm: velho });
    registrarOferta({ origem: "g1", desfecho: "ENCAMINHADO" });
    assert.equal(podarCatalogo(30), 1);
    assert.equal(listarOfertas().total, 1);
    assert.equal(podarCatalogo(0), 0, "janela inválida não apaga nada");
  } finally {
    encerrar(dir);
  }
});

test("limpar apaga tudo e devolve a contagem", () => {
  const dir = novoDir();
  try {
    registrarOferta({ origem: "g1", desfecho: "ENCAMINHADO" });
    registrarOferta({ origem: "g1", desfecho: "DUPLICADO" });
    assert.equal(limparCatalogo(), 2);
    assert.equal(listarOfertas().total, 0);
  } finally {
    encerrar(dir);
  }
});

test("INSERT OR REPLACE: gravar o mesmo id não duplica", () => {
  const dir = novoDir();
  try {
    registrarOferta({ id: "fixo", origem: "g1", desfecho: "REVISAO", motivo: "pendente" });
    registrarOferta({ id: "fixo", origem: "g1", desfecho: "ENCAMINHADO", motivo: null });
    assert.equal(listarOfertas().total, 1);
    assert.equal(listarOfertas().itens[0].desfecho, "ENCAMINHADO", "última gravação vence");
  } finally {
    encerrar(dir);
  }
});

test("degradação segura: CATALOGO_BD=0 não grava e não lança", () => {
  const dir = novoDir();
  try {
    process.env.CATALOGO_BD = "0";
    fecharBanco();
    assert.equal(registrarOferta({ origem: "g1", desfecho: "ENCAMINHADO" }), null);
    assert.equal(listarOfertas().total, 0);
    assert.equal(resumoCatalogo().total, 0);
    assert.equal(podarCatalogo(30), 0);
    assert.equal(limparCatalogo(), 0);
    assert.match(catalogoCsv(), /^data;origem;/);
  } finally {
    encerrar(dir);
  }
});

test("dados malformados não derrubam o catálogo", () => {
  const dir = novoDir();
  try {
    assert.ok(registrarOferta({ origem: "   ", desfecho: "ERRO" }), "origem vazia cai no padrão");
    const o = listarOfertas().itens[0];
    assert.equal(o.origem, "desconhecida");
    assert.equal(o.programa, null);
    assert.equal(o.preco, null);
  } finally {
    encerrar(dir);
  }
});
