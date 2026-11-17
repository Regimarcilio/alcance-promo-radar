/**
 * Testes do REENVIO do catálogo (ADR-012, fase 3).
 *
 * A regra que mais importa aqui: o lote NUNCA aceita o que o individual recusa,
 * e um item inválido no meio da seleção não derruba os outros.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fila.ts guarda o estado em cache na memória: um data dir só para o arquivo
// inteiro + limpeza explícita entre casos. (Trocar o dir não basta: o cache
// continuaria apontando para o arquivo antigo.)
const DIR = mkdtempSync(join(tmpdir(), "alcance-reenvio-"));
process.env.ALCANCE_DATA_DIR = DIR;
delete process.env.CATALOGO_BD;
after(() => rmSync(DIR, { recursive: true, force: true }));

const ORIGEM = "120363111111@g.us";
const DESTINO = "120363222222@g.us";

async function preparar(opts: { autoEnviar?: boolean; semDestino?: boolean } = {}) {
  const agora = new Date().toISOString();
  writeFileSync(
    join(DIR, "monitor.json"),
    JSON.stringify({
      regras: [
        {
          origem: { jid: ORIGEM, nome: "Origem", ativo: true, criadoEm: agora },
          destinos: opts.semDestino ? [] : [{ jid: DESTINO, nome: "Destino", ativo: true, criadoEm: agora }],
          criadoEm: agora,
        },
      ],
      autoEnviar: opts.autoEnviar ?? true,
      foto: "origem",
      criadoEm: agora,
    })
  );
  const { fecharBanco } = await import("../store/db.js");
  fecharBanco();
  const catalogo = await import("../store/catalogo.js");
  catalogo.limparCatalogo();
  const fila = await import("./fila.js");
  fila.limparFila();
  const mod = await import("./reenvio.js");
  return { mod, catalogo, dir: DIR };
}

/** Grava uma oferta direto no catálogo e devolve o id. */
function oferta(
  catalogo: typeof import("../store/catalogo.js"),
  extra: Partial<import("../store/catalogo.js").RegistroOferta> = {}
): string {
  return catalogo.registrarOferta({
    origem: ORIGEM,
    programa: "ml",
    idProduto: "MLB1",
    titulo: "Fone",
    link: "https://ml/sec/1",
    mensagem: "🔥 Fone\nlink",
    desfecho: "ENCAMINHADO",
    ...extra,
  })!;
}

test("oferta inexistente -> 404", async () => {
  const { mod } = await preparar();
  {
    const r = mod.validarReenvio(null);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  }
});

test("oferta descartada antes da formatação (sem mensagem) -> 409", async () => {
  const { mod, catalogo } = await preparar();
  {
    const id = oferta(catalogo, { mensagem: null, desfecho: "IGNORADO" });
    const r = mod.validarReenvio(catalogo.obterOferta(id));
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.erro, /não há mensagem/);
  }
});

test("envio direto desligado -> 409 (não reenfileira às cegas)", async () => {
  const { mod, catalogo } = await preparar({ autoEnviar: false });
  {
    const id = oferta(catalogo);
    const r = mod.reenviarOferta(id);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.erro, /desligado/);
    assert.equal(mod.reenviarLote([id]).enfileiradas, 0);
  }
});

test("origem sem destino configurado -> 409", async () => {
  const { mod, catalogo } = await preparar({ semDestino: true });
  {
    const id = oferta(catalogo);
    const r = mod.reenviarOferta(id);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.erro, /destino/);
  }
});

test("reenvio individual entra na fila marcado como reenvioManual", async () => {
  const { mod, catalogo } = await preparar();
  {
    const id = oferta(catalogo);
    const r = mod.reenviarOferta(id);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.destinos, [DESTINO]);
    assert.equal(r.item.reenvioManual, true);
    assert.equal(r.item.mensagem, "🔥 Fone\nlink");
    assert.equal(r.fila, 1);
  }
});

test("lote: válidas entram, inválidas viram motivo — sem abortar o resto", async () => {
  const { mod, catalogo } = await preparar();
  {
    const ok1 = oferta(catalogo, { idProduto: "MLB1" });
    const ok2 = oferta(catalogo, { idProduto: "MLB2" });
    const semMsg = oferta(catalogo, { idProduto: "MLB3", mensagem: null, desfecho: "IGNORADO" });
    const r = mod.reenviarLote([ok1, semMsg, "nao-existe", ok2]);
    assert.equal(r.enfileiradas, 2);
    assert.equal(r.ignoradas.length, 2);
    assert.equal(r.fila, 2);
    assert.ok(r.ignoradas.some((i: { id: string }) => i.id === "nao-existe"));
    assert.ok(r.ignoradas.some((i: { id: string }) => i.id === semMsg));
  }
});

test("reenvio manual de duas vezes não é bloqueado pela trava de duplicata", async () => {
  const { mod, catalogo } = await preparar();
  {
    const id = oferta(catalogo);
    const r1 = mod.reenviarLote([id]);
    assert.equal(r1.enfileiradas, 1);
    assert.equal(r1.fila, 1);
    const r2 = mod.reenviarLote([id]);
    assert.equal(r2.enfileiradas, 1, "o operador pediu de novo");
    assert.equal(r2.fila, 2, "as duas cópias coexistem na fila");
  }
});

test("normalizarIds: só strings, sem vazios, sem repetição", async () => {
  const { mod } = await preparar();
  {
    assert.deepEqual(mod.normalizarIds(["a", "a", " b ", "", 1, null, undefined, {}]), ["a", "b"]);
    assert.deepEqual(mod.normalizarIds("x"), []);
    assert.deepEqual(mod.normalizarIds(undefined), []);
  }
});
