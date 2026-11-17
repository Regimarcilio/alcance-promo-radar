/**
 * Contabilidade dos disparos (issue #82) — o contador de falha tem que
 * refletir quem está **morto na DLQ agora**, não quantas vezes a mensagem
 * morreu. Sem isso, `enviados + falhas` passa do `total` e a campanha nunca
 * fecha como CONCLUIDO, mesmo com todos os contatos recebendo a mensagem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "alcance-disparo-conta-"));
process.env.ALCANCE_DATA_DIR = dir;
const mod = await import("./disparos.js");

const JID = "5511999990001@s.whatsapp.net";

test("sucesso limpa o erro antigo do disparo", () => {
  const d = mod.criarDisparo({ texto: "oferta", jids: [JID] });
  mod.registrarResultadoDisparo(d.id, false, "caminho de mídia não permitido");
  assert.equal(mod.obterDisparo(d.id)?.erro, "caminho de mídia não permitido");

  mod.registrarResultadoDisparo(d.id, true);
  const depois = mod.obterDisparo(d.id);
  assert.equal(depois?.erro, null, "erro antigo não pode ficar na tela depois do sucesso");
  assert.equal(depois?.enviados, 1);
  assert.equal(depois?.falhas, 1);
});

test("descontaFalhaDisparo: reprocessar devolve a falha ao contador", () => {
  const d = mod.criarDisparo({ texto: "oferta", jids: [JID, "5511999990002@s.whatsapp.net"] });
  mod.registrarResultadoDisparo(d.id, false, "mídia expirada");
  assert.equal(mod.obterDisparo(d.id)?.falhas, 1);

  mod.descontaFalhaDisparo(d.id);
  assert.equal(mod.obterDisparo(d.id)?.falhas, 0, "o item reprocessado não é mais uma falha");
});

test("disparo com tudo entregue fica CONCLUIDO (falhas zeradas)", () => {
  const d = mod.criarDisparo({ texto: "oferta", jids: [JID, "5511999990002@s.whatsapp.net"] });
  mod.registrarResultadoDisparo(d.id, false, "mídia expirada"); // 1 morreu
  mod.descontaFalhaDisparo(d.id); // foi reprocessado → não é mais falha
  mod.registrarResultadoDisparo(d.id, true);
  mod.registrarResultadoDisparo(d.id, true);

  const final = mod.obterDisparo(d.id);
  assert.equal(final?.enviados, 2);
  assert.equal(final?.falhas, 0);
  assert.equal(final?.status, "CONCLUIDO", "todos entregaram → CONCLUIDO");
});

test("definirFalhasDisparo: zera as falhas e limpa o erro", () => {
  const d = mod.criarDisparo({ texto: "oferta", jids: [JID] });
  mod.registrarResultadoDisparo(d.id, false, "caminho de mídia não permitido");
  mod.registrarResultadoDisparo(d.id, true);

  mod.definirFalhasDisparo(d.id, 0);
  const depois = mod.obterDisparo(d.id);
  assert.equal(depois?.falhas, 0);
  assert.equal(depois?.erro, null);
});

test("definirFalhasDisparo: mantém o disparo PARCIAL com mortos na DLQ", () => {
  const d = mod.criarDisparo({ texto: "oferta", jids: [JID, "5511999990002@s.whatsapp.net"] });
  mod.registrarResultadoDisparo(d.id, true);
  mod.definirFalhasDisparo(d.id, 1);
  const depois = mod.obterDisparo(d.id);
  assert.equal(depois?.falhas, 1);
  assert.equal(depois?.status, "PARCIAL");
});

test("reconciliarFalhasDisparos: alinha o contador com a DLQ real", async () => {
  const d = mod.criarDisparo({ texto: "oferta", jids: [JID] });
  mod.registrarResultadoDisparo(d.id, false, "caminho de mídia não permitido");
  mod.registrarResultadoDisparo(d.id, true);
  assert.equal(mod.obterDisparo(d.id)?.falhas, 1);

  // a DLQ está vazia → o contador de falha tem que ir a zero
  const dlqMod = await import("../messaging/dlq.js");
  const brokerMod = await import("../messaging/broker.js");
  brokerMod.resetBroker();
  const ops = await import("../messaging/dlq-operacoes.js");
  const r = ops.reconciliarFalhasDisparos();
  assert.ok(Array.isArray(r));
  assert.equal(mod.obterDisparo(d.id)?.falhas, 0, "sem item na DLQ não há falha");
  assert.ok(dlqMod.tiposComDlq().length >= 0);
});
