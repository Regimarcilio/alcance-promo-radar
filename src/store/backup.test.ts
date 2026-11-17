/**
 * Testes do backup do banco (ADR-012, fase 4).
 *
 * O que precisa valer:
 * - o arquivo gerado ABRE e tem os mesmos dados (VACUUM INTO é consistente);
 * - existe política (um por período, com retenção), não é "backup quando lembrar";
 * - sem banco, falha de forma controlada (não lança).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

async function preparar(catLigado = true) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-backup-"));
  process.env.ALCANCE_DATA_DIR = dir;
  if (catLigado) delete process.env.CATALOGO_BD;
  else process.env.CATALOGO_BD = "0";
  const { fecharBanco } = await import("./db.js");
  fecharBanco();
  const catalogo = await import("./catalogo.js");
  const backup = await import(`./backup.js?v=${Math.random()}`);
  return { backup, catalogo, dir };
}

function oferta(i: number) {
  return {
    origem: "120363@g.us",
    programa: "ml",
    idProduto: `MLB${i}`,
    titulo: `Oferta ${i}`,
    link: "https://ml/sec/" + i,
    desfecho: "ENCAMINHADO" as const,
  };
}

test("backup abre e tem os mesmos dados do banco", async () => {
  const { backup, catalogo, dir } = await preparar();
  try {
    for (let i = 1; i <= 5; i++) catalogo.registrarOferta(oferta(i));
    const r = backup.backupBanco();
    assert.equal(r.ok, true);
    assert.ok(r.backup && r.backup.bytes > 0);

    const copia = new DatabaseSync(r.backup!.caminho);
    const n = (copia.prepare("SELECT COUNT(*) AS n FROM ofertas").get() as { n: number }).n;
    const t = (copia.prepare("SELECT titulo FROM ofertas WHERE id_produto = 'MLB3'").get() as {
      titulo: string;
    }).titulo;
    copia.close();
    assert.equal(Number(n), 5);
    assert.equal(t, "Oferta 3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("política: não faz outro backup antes do intervalo", async () => {
  const { backup, catalogo, dir } = await preparar();
  try {
    catalogo.registrarOferta(oferta(1));
    assert.equal(backup.backupDevido(24), true, "nunca fez -> devido");
    assert.equal(backup.backupSeDevido().feito, true);
    assert.equal(backup.backupDevido(24), false, "acabou de fazer");
    assert.equal(backup.backupSeDevido().feito, false);
    assert.equal(backup.backupDevido(0), false, "0 desliga a política");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("política: volta a ser devido quando o último envelhece", async () => {
  const { backup, catalogo, dir } = await preparar();
  try {
    catalogo.registrarOferta(oferta(1));
    const r = backup.backupBanco();
    const antigo = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(r.backup!.caminho, antigo, antigo);
    assert.equal(backup.backupDevido(24), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retenção: mantém só os N mais recentes", async () => {
  const { backup, catalogo, dir } = await preparar();
  try {
    catalogo.registrarOferta(oferta(1));
    for (let i = 0; i < 5; i++) {
      const nome = join(dir, "backups", `alcance-2026-01-0${i + 1}T00-00-00-000Z.db`);
      backup.backupBanco();
      // renomeia com data fixa para a ordenação ser determinística
      const feito = backup.listarBackups()[0];
      if (feito) {
        const { renameSync } = await import("node:fs");
        try {
          renameSync(feito.caminho, nome);
        } catch {
          /* já renomeado */
        }
      }
    }
    const total = backup.listarBackups().length;
    assert.ok(total >= 5, "criou os arquivos");
    const removidos = backup.podarBackups(3);
    assert.equal(removidos, total - 3);
    assert.equal(backup.listarBackups().length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sem banco: falha controlada, sem lançar", async () => {
  const { backup, dir } = await preparar(false);
  try {
    const r = backup.backupBanco();
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /indisponível/);
    assert.equal(backup.listarBackups().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listarBackups ignora arquivos que não são backup", async () => {
  const { backup, dir } = await preparar();
  try {
    backup.backupBanco();
    writeFileSync(join(dir, "backups", "outra-coisa.txt"), "x");
    const l = backup.listarBackups();
    assert.equal(l.length, 1);
    assert.match(l[0].nome, /^alcance-.*\.db$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
