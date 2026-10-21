/** Testes da adição de participantes em grupo (Evolution updateParticipant). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adicionarParticipantes, buscarPermissaoGrupo, definirPermissaoGrupo } from "./evolution.js";
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

test("permissão: updateSetting com action=announcement", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  let url = "";
  let corpo = "";
  const m = mockFetch(async (u, init) => {
    url = u;
    corpo = String(init?.body);
    return resJson({});
  });
  try {
    const r = await definirPermissaoGrupo(GRUPO, "announcement");
    assert.equal(r.ok, true);
    assert.match(url, /\/group\/updateSetting\/inst-teste\?groupJid=120363000000000000%40g\.us/);
    assert.deepEqual(JSON.parse(corpo), { action: "announcement" });
  } finally {
    m.restaurar();
  }
});

test("permissão: grupo inválido não toca na rede", async () => {
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await definirPermissaoGrupo("5511999999999@s.whatsapp.net", "announcement");
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /grupo inválido/);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
  }
});

test("permissão: 403 da Evolution avisa que a conta precisa ser admin", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  const m = mockFetch(async () => new Response("forbidden", { status: 403 }));
  try {
    const r = await definirPermissaoGrupo(GRUPO, "announcement");
    assert.equal(r.ok, false);
    assert.match(r.erro ?? "", /Evolution 403/);
    assert.match(r.erro ?? "", /admin/);
  } finally {
    m.restaurar();
  }
});

test("permissão: estado atual (announce/restrict) via findGroupInfos", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  const m = mockFetch(async () =>
    resJson({ subject: "Mano dos Achadinhos", size: 5, announce: true, restrict: false }),
  );
  try {
    const p = await buscarPermissaoGrupo(GRUPO);
    assert.equal(p?.announce, true);
    assert.equal(p?.restrict, false);
    assert.equal(p?.tamanho, 5);
    assert.equal(p?.nome, "Mano dos Achadinhos");
  } finally {
    m.restaurar();
  }
});

test("lista de grupos: cache em disco sobrevive a falha da Evolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alcance-grupos-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./evolution.js?v=${Math.random()}`);

  // 1) Evolution devolve a lista -> é gravada no cache
  const ok = mockFetch(async () =>
    resJson([{ id: "120363@g.us", subject: "Mano dos Achadinhos", size: 5 }]),
  );
  try {
    const grupos = await mod.listarGrupos(true);
    assert.equal(grupos.length, 1);
    assert.equal(grupos[0].nome, "Mano dos Achadinhos");
  } finally {
    ok.restaurar();
  }

  // 2) Evolution fora do ar -> o cache em disco ainda devolve os grupos
  const falha = mockFetch(async () => {
    throw new Error("Evolution 500");
  });
  try {
    const doCache = mod.gruposDoCache();
    assert.equal(doCache.grupos.length, 1);
    assert.equal(doCache.grupos[0].jid, "120363@g.us");
    assert.ok(doCache.em, "cache deve ter timestamp");
  } finally {
    falha.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
