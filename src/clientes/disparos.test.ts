import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALCANCE_DATA_DIR = mkdtempSync(join(tmpdir(), "alcance-disparos-"));
const mod = await import("./disparos.js");

const JIDS = ["5511999990001@s.whatsapp.net", "5511999990002@s.whatsapp.net"];

test("cria disparo e lista do mais recente para o mais antigo", () => {
  const a = mod.criarDisparo({ texto: "primeira", jids: JIDS, listaNome: "VIP" });
  const b = mod.criarDisparo({ texto: "segunda", jids: [JIDS[0]] });
  const lista = mod.listarDisparos();
  assert.equal(lista[0].id, b.id);
  assert.equal(lista[1].id, a.id);
  assert.equal(a.status, "PENDENTE");
  assert.equal(a.total, 2);
  assert.equal(a.enviados, 0);
});

test("exige mensagem/mídia e pelo menos 1 contato", () => {
  assert.throws(() => mod.criarDisparo({ texto: "  ", jids: JIDS }), /mensagem ou escolha uma mídia/);
  assert.throws(() => mod.criarDisparo({ texto: "oi", jids: [] }), /não tem contatos/);
});

test("aceita mídia sem texto", () => {
  const d = mod.criarDisparo({
    texto: "",
    jids: [JIDS[0]],
    midia: { arquivo: "data/midia/x.jpg", mime: "image/jpeg", tipo: "image" },
  });
  assert.equal(d.texto, "");
  assert.equal(d.midia?.tipo, "image");
});

test("textoComLink anexa o link no fim", () => {
  assert.equal(mod.textoComLink("oi", "https://x.y"), "oi\n\nhttps://x.y");
  assert.equal(mod.textoComLink("oi", ""), "oi");
  assert.equal(mod.textoComLink("", "https://x.y"), "https://x.y");
});

test("edita enquanto PENDENTE e bloqueia depois de enviar", () => {
  const d = mod.criarDisparo({ texto: "antes", jids: [JIDS[0], JIDS[1]] });
  const editado = mod.editarDisparo(d.id, { texto: "depois", link: "https://meli.la/x" });
  assert.equal(editado.texto, "depois");
  assert.equal(editado.link, "https://meli.la/x");

  mod.registrarResultadoDisparo(d.id, true);
  assert.throws(() => mod.editarDisparo(d.id, { texto: "tarde" }), /não enviado/);
});

test("progresso: ENVIANDO → CONCLUIDO / PARCIAL / ERRO", () => {
  const ok = mod.criarDisparo({ texto: "ok", jids: [JIDS[0], JIDS[1]] });
  mod.registrarResultadoDisparo(ok.id, true);
  assert.equal(mod.obterDisparo(ok.id)?.status, "ENVIANDO");
  mod.registrarResultadoDisparo(ok.id, true);
  assert.equal(mod.obterDisparo(ok.id)?.status, "CONCLUIDO");

  const parcial = mod.criarDisparo({ texto: "p", jids: [JIDS[0], JIDS[1]] });
  mod.registrarResultadoDisparo(parcial.id, true);
  mod.registrarResultadoDisparo(parcial.id, false, "Connection Closed");
  const p = mod.obterDisparo(parcial.id)!;
  assert.equal(p.status, "PARCIAL");
  assert.equal(p.enviados, 1);
  assert.equal(p.falhas, 1);
  assert.match(String(p.erro), /Connection Closed/);

  const erro = mod.criarDisparo({ texto: "e", jids: [JIDS[0]] });
  mod.registrarResultadoDisparo(erro.id, false, "401");
  assert.equal(mod.obterDisparo(erro.id)?.status, "ERRO");
});

test("duplicar cria cópia PENDENTE com os mesmos destinos", () => {
  const d = mod.criarDisparo({ texto: "base", jids: JIDS, listaId: "L1", listaNome: "Lista 1" });
  mod.registrarResultadoDisparo(d.id, true);
  const copia = mod.duplicarDisparo(d.id);
  assert.notEqual(copia.id, d.id);
  assert.equal(copia.status, "PENDENTE");
  assert.equal(copia.enviados, 0);
  assert.equal(copia.falhas, 0);
  assert.deepEqual(copia.jids, JIDS);
  assert.equal(copia.listaId, "L1");
});

test("excluir remove o registro; cancelar marca CANCELADO", () => {
  const d = mod.criarDisparo({ texto: "x", jids: [JIDS[0]] });
  assert.equal(mod.excluirDisparo(d.id), true);
  assert.equal(mod.obterDisparo(d.id), null);
  assert.equal(mod.excluirDisparo("nao-existe"), false);

  const c = mod.criarDisparo({ texto: "y", jids: [JIDS[0]] });
  assert.equal(mod.cancelarDisparo(c.id)?.status, "CANCELADO");
  // cancelado não volta a mudar de status ao registrar resultado
  mod.registrarResultadoDisparo(c.id, true);
  assert.equal(mod.obterDisparo(c.id)?.status, "CANCELADO");
});

test("resumo conta status, enviados e falhas", () => {
  const r = mod.resumoDisparos();
  assert.ok(r.total >= 1);
  assert.equal(
    Object.values(r.porStatus).reduce((a, b) => a + b, 0),
    r.total,
  );
  assert.ok(r.enviados >= 1);
});

test.after(() => rmSync(process.env.ALCANCE_DATA_DIR!, { recursive: true, force: true }));
