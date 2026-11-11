/**
 * Regressão: "Testar" (dryRun) é simulação — não pode inflar contadores nem
 * reservar dedup, senão a oferta real do mesmo produto vira DUPLICADO.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "./test-utils.js";

const ORIGEM = "120363429892871960@g.us";
const DESTINO = "120363412937047408@g.us";

test("dryRun não altera contadores nem consome dedup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-webhook-"));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.AMAZON_TAG = "teste-20";
  writeFileSync(
    join(dir, "monitor.json"),
    JSON.stringify({
      regras: [{
        origem: { jid: ORIGEM, nome: "origem", ativo: true, criadoEm: new Date().toISOString() },
        destinos: [{ jid: DESTINO, nome: "destino", ativo: true, criadoEm: new Date().toISOString() }],
        criadoEm: new Date().toISOString(),
      }],
      autoEnviar: true,
      foto: "origem",
      criadoEm: new Date().toISOString(),
    }),
  );
  const m = mockFetch(async () => new Response(null, { status: 404 }));
  try {
    const { processar } = await import("./webhook.js");
    const { resumo, totalHashes } = await import("./state.js");
    const msg = {
      origem: ORIGEM,
      deMim: false,
      texto: "Oferta Amazon https://www.amazon.com.br/dp/B0GJ7GG3YV?tag=origem-20",
      messageId: "teste-dry",
    };
    const r1 = await processar(msg, { dryRun: true });
    const r2 = await processar(msg, { dryRun: true });
    assert.equal(r1.acao, "ENCAMINHADO");
    assert.equal(r2.acao, "ENCAMINHADO", "segundo teste não pode virar DUPLICADO");
    assert.equal(resumo().recebidas, 0);
    assert.equal(resumo().encaminhadas, 0);
    assert.equal(totalHashes(), 0);
  } finally {
    m.restaurar();
    delete process.env.AMAZON_TAG;
    rmSync(dir, { recursive: true, force: true });
  }
});
