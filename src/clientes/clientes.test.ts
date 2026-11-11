/**
 * Testes do sync de contatos (ritmo, backoff e contagem de erros).
 * O ritmo (pausa entre grupos) é o que impede o WhatsApp de cortar o sync
 * com 429 "rate-overlimit" — por isso o teste verifica as chamadas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch, resJson } from "../monitor/test-utils.js";

/** Carrega o módulo de clientes com data dir temporário e ritmo 0 (teste rápido). */
async function carregarClientes() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-clientes-"));
  writeFileSync(join(dir, "clientes.json"), JSON.stringify({ contatos: [], listas: [], ultimoSync: null }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  process.env.SYNC_PAUSA_MS = "0";
  process.env.SYNC_BACKOFF_MS = "0";
  const mod = await import(`./clientes.js?v=${Math.random()}`);
  return { mod, dir };
}

/**
 * Carrega o módulo de clientes com data dir temporário (fila de campanhas).
 * O `dataDir` é resolvido no import do módulo — por isso o cache-buster.
 */
async function carregarFila() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-fila-"));
  writeFileSync(join(dir, "clientes.json"), JSON.stringify({ contatos: [], listas: [], ultimoSync: null }));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./clientes.js?v=${Math.random()}`);
  return { mod, dir };
}

/** Lê os itens da fila gravados em data/clientes-fila.json. */
function lerItensFila(dir: string): any[] {
  const raw = JSON.parse(readFileSync(join(dir, "clientes-fila.json"), "utf8"));
  return Array.isArray(raw?.itens) ? raw.itens : [];
}

const GRUPOS = [
  { id: "g1@g.us", subject: "Grupo Um" },
  { id: "g2@g.us", subject: "Grupo Dois" },
  { id: "g3@g.us", subject: "Grupo Três" },
];

test("fila: o item carrega o número escolhido na campanha (issue #45)", async () => {
  const { mod, dir } = await carregarFila();
  try {
    mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000001@s.whatsapp.net"],
      disparoId: "disp-1",
      instancia: "radar-47997136647-uzz",
    });
    const itens = lerItensFila(dir);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].instancia, "radar-47997136647-uzz");
    assert.equal(itens[0].disparoId, "disp-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: sem número escolhido o item fica em Automático (fallback p/ o rodízio)", async () => {
  const { mod, dir } = await carregarFila();
  try {
    mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000002@s.whatsapp.net"],
      disparoId: "disp-2",
    });
    const itens = lerItensFila(dir);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].instancia, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: atualizarItensDaFila troca o número dos itens pendentes", async () => {
  const { mod, dir } = await carregarFila();
  try {
    mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000003@s.whatsapp.net"],
      disparoId: "disp-3",
      instancia: "inst-antigo",
    });
    const n = mod.atualizarItensDaFila("disp-3", {
      texto: "oferta nova",
      instancia: "inst-novo",
    });
    assert.equal(n, 1);
    assert.equal(lerItensFila(dir)[0].instancia, "inst-novo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync: importa participantes de todos os grupos", async () => {
  const { mod, dir } = await carregarClientes();
  const m = mockFetch(async (url: string) => {
    if (url.includes("fetchAllGroups")) return resJson(GRUPOS);
    const jid = decodeURIComponent(url.split("groupJid=")[1]);
    const n = jid === "g1@g.us" ? 1 : jid === "g2@g.us" ? 2 : 3;
    return resJson({
      participants: Array.from({ length: n }, (_, i) => ({ phoneNumber: `5511900000${jid[1]}${i}` })),
    });
  });
  try {
    const r = await mod.sincronizar();
    assert.equal(r.novos, 6);
    assert.equal(r.total, 6);
    const st = mod.estadoSync();
    assert.equal(st.feitos, 3);
    assert.equal(st.total, 3);
    assert.equal(st.erros ?? 0, 0);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync: grupo com rate limit (500) conta erro e segue para os outros", async () => {
  const { mod, dir } = await carregarClientes();
  const m = mockFetch(async (url: string) => {
    if (url.includes("fetchAllGroups")) return resJson(GRUPOS);
    const jid = decodeURIComponent(url.split("groupJid=")[1]);
    if (jid === "g2@g.us") return new Response("Internal Server Error", { status: 500 });
    return resJson({ participants: [{ phoneNumber: `5511900000${jid[1]}0` }] });
  });
  try {
    const r = await mod.sincronizar();
    // g1 e g3 trouxeram 1 contato cada; g2 falhou
    assert.equal(r.novos, 2);
    const st = mod.estadoSync();
    assert.equal(st.feitos, 3);
    assert.equal(st.erros, 1);
    assert.match(st.ultimoErro ?? "", /rate limit/i);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync: 403 (grupo sem permissão) não conta como erro", async () => {
  const { mod, dir } = await carregarClientes();
  const m = mockFetch(async (url: string) => {
    if (url.includes("fetchAllGroups")) return resJson(GRUPOS);
    const jid = decodeURIComponent(url.split("groupJid=")[1]);
    if (jid === "g3@g.us") return new Response("forbidden", { status: 403 });
    return resJson({ participants: [{ phoneNumber: `5511900000${jid[1]}0` }] });
  });
  try {
    await mod.sincronizar();
    const st = mod.estadoSync();
    assert.equal(st.erros, 0);
    assert.equal(st.feitos, 3);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync: rate limit faz retry (2 tentativas no mesmo grupo)", async () => {
  const { mod, dir } = await carregarClientes();
  let tentativasG2 = 0;
  const m = mockFetch(async (url: string) => {
    if (url.includes("fetchAllGroups")) return resJson([GRUPOS[1]]);
    tentativasG2++;
    if (tentativasG2 === 1) return new Response("Internal Server Error", { status: 500 });
    return resJson({ participants: [{ phoneNumber: "5511900000099" }] });
  });
  try {
    const r = await mod.sincronizar();
    assert.equal(tentativasG2, 2);
    assert.equal(r.novos, 1);
    assert.equal(mod.estadoSync().erros, 0);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
