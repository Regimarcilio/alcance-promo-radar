/** Testes da adição de participantes em grupo (Evolution updateParticipant). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adicionarUmParticipante, buscarPermissaoGrupo, definirPermissaoGrupo } from "./evolution.js";
import { mockFetch, resJson } from "./test-utils.js";

const GRUPO = "120363000000000000@g.us";

/**
 * Ambiente isolado: o store de instâncias precisa conhecer a instância do
 * teste (as operações de serviço usam sempre o número principal).
 */
function ambiente(principal = "inst-teste"): string {
  const dir = mkdtempSync(join(tmpdir(), "alcance-evo-"));
  writeFileSync(
    join(dir, "instancias.json"),
    JSON.stringify({
      itens: [
        { instancia: principal, nome: "Principal", ativo: true, peso: 5, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" },
        { instancia: "secundario-1", nome: "Secundário 1", ativo: true, peso: 5, enviadas: 0, ultimaEm: null, criadaEm: "" },
      ],
    }),
  );
  process.env.ALCANCE_DATA_DIR = dir;
  return dir;
}

test("adiciona participante: normaliza para +código e envia action=add", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  ambiente("inst-teste");
  let corpo = "";
  const m = mockFetch(async (url, init) => {
    assert.match(url, /\/group\/updateParticipant\/inst-teste\?groupJid=120363000000000000%40g\.us/);
    corpo = String(init?.body);
    return resJson({ updateParticipants: [] });
  });
  try {
    const r = await adicionarUmParticipante(GRUPO, "5511999999999");
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(corpo), { action: "add", participants: ["+5511999999999"] });
  } finally {
    m.restaurar();
  }
});

test("adiciona participante: rate-overlimit faz retry", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  ambiente("inst-teste");
  let chamadas = 0;
  const m = mockFetch(async () => {
    chamadas++;
    if (chamadas === 1) {
      return resJson({ message: ["Error updating participants", "Error: rate-overlimit"] }, 400);
    }
    return resJson({ updateParticipants: [] });
  });
  try {
    const r = await adicionarUmParticipante(GRUPO, "5511999999999", { esperas: 0, tentativas: 3 });
    assert.equal(r.ok, true);
    assert.equal(chamadas, 2, "deveria tentar de novo após o limite");
  } finally {
    m.restaurar();
  }
});

test("adiciona participante: limite persistente devolve aviso de limitação", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  ambiente("inst-teste");
  const m = mockFetch(async () =>
    resJson({ message: ["Error updating participants", "Error: rate-overlimit"] }, 400),
  );
  try {
    const r = await adicionarUmParticipante(GRUPO, "5511999999999", { esperas: 0, tentativas: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.limitado, true);
    assert.match(r.erro ?? "", /rate-overlimit/);
  } finally {
    m.restaurar();
  }
});

test("adiciona participante: 409 na resposta = já estava no grupo (sucesso)", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  ambiente("inst-teste");
  const m = mockFetch(async () =>
    resJson({ updateParticipants: [{ status: 409, content: { error: "409" } }] }),
  );
  try {
    const r = await adicionarUmParticipante(GRUPO, "5511999999999");
    assert.equal(r.ok, true);
    assert.equal(r.jaNoGrupo, true);
  } finally {
    m.restaurar();
  }
});

test("adiciona participante: grupo/número inválido não toca a rede", async () => {
  const m = mockFetch(async () => resJson({}));
  try {
    const r1 = await adicionarUmParticipante("5511999999999@s.whatsapp.net", "5511999999999");
    assert.equal(r1.ok, false);
    const r2 = await adicionarUmParticipante(GRUPO, "123");
    assert.equal(r2.ok, false);
    assert.equal(m.chamadas.length, 0);
  } finally {
    m.restaurar();
  }
});

test("grupo inválido: erro sem tocar na rede", async () => {
  const m = mockFetch(async () => resJson({}));
  try {
    const r = await adicionarUmParticipante("5511999999999@s.whatsapp.net", "5511999999999");
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
  ambiente("inst-teste");
  const m = mockFetch(async () => new Response("forbidden", { status: 403 }));
  try {
    const r = await adicionarUmParticipante(GRUPO, "5511999999999");
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
  ambiente("inst-teste");
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
  ambiente("inst-teste");
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
  ambiente("inst-teste");
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

test("grupos: consulta todas as instâncias ativas e une os grupos", async () => {
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  // .env de produção pode continuar com o nome de fábrica; o store manda.
  process.env.EVO_INSTANCE = "inst-antiga";
  const dir = ambiente("inst-principal");
  const mod = await import(`./evolution.js?v=${Math.random()}`);
  const urls: string[] = [];
  const m = mockFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes("inst-principal")) {
      return resJson([{ id: "120363111@g.us", subject: "Grupo do principal", size: 1 }]);
    }
    return resJson([{ id: "120363222@g.us", subject: "Grupo do secundário", size: 2 }]);
  });
  try {
    const grupos = await mod.listarGrupos(true);
    assert.equal(grupos.length, 2);
    assert.ok(urls.some((u) => /\/group\/fetchAllGroups\/inst-principal\?/.test(u)));
    assert.ok(urls.some((u) => /\/group\/fetchAllGroups\/secundario-1\?/.test(u)));
    assert.ok(!urls.some((u) => /inst-antiga/.test(u)));
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
