/** Testes da adição de participantes em grupo (Evolution updateParticipant). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { adicionarParticipantes } from "./evolution.js";
import { mockFetch, resJson } from "./test-utils.js";

const GRUPO = "120363000000000000@g.us";

test("adiciona participantes: normaliza para +código e envia action=add", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  let corpo = "";
  let url = "";
  const m = mockFetch(async (u, init) => {
    url = u;
    corpo = String(init?.body);
    return resJson({});
  });
  try {
    const r = await adicionarParticipantes(GRUPO, ["5511999999999", "5511988888888@s.whatsapp.net"]);
    assert.equal(r.ok, true);
    assert.equal(r.adicionados, 2);
    assert.match(url, /\/group\/updateParticipant\/inst-teste\?groupJid=120363000000000000%40g\.us/);
    const body = JSON.parse(corpo) as { action: string; participants: string[] };
    assert.equal(body.action, "add");
    assert.deepEqual(body.participants, ["+5511999999999", "+5511988888888"]);
  } finally {
    m.restaurar();
  }
});

test("números duplicados ou curtos são ignorados", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  let corpo = "";
  const m = mockFetch(async (_u, init) => {
    corpo = String(init?.body);
    return resJson({});
  });
  try {
    const r = await adicionarParticipantes(GRUPO, ["5511999999999", "5511999999999", "123"]);
    assert.equal(r.ok, true);
    assert.equal(r.adicionados, 1);
    const body = JSON.parse(corpo) as { participants: string[] };
    assert.deepEqual(body.participants, ["+5511999999999"]);
  } finally {
    m.restaurar();
  }
});

test("grupo inválido: erro sem tocar na rede", async () => {
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await adicionarParticipantes("5511999999999@s.whatsapp.net", ["5511999999999"]);
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /grupo inválido/);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
  }
});

test("erro da API (403): devolve erro com status, sem lançar", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  const m = mockFetch(async () => new Response("forbidden", { status: 403 }));
  try {
    const r = await adicionarParticipantes(GRUPO, ["5511999999999"]);
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /Evolution 403/);
  } finally {
    m.restaurar();
  }
});
