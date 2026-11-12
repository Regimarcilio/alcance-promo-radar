/** Segurança do envio: allowlist de mídia local e anti-SSRF em URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarImagem, enviarParaGrupo } from "./dispatch.js";

test("validarImagem: aceita vazio, https público e data:image", () => {
  assert.doesNotThrow(() => validarImagem(""));
  assert.doesNotThrow(() => validarImagem("https://cdn.exemplo.com/foto.jpg"));
  assert.doesNotThrow(() => validarImagem("data:image/png;base64,AAAA"));
});

test("validarImagem: recusa path traversal e caminho arbitrário", () => {
  assert.throws(() => validarImagem("/etc/passwd"));
  assert.throws(() => validarImagem("data/midia/../../etc/passwd"));
  assert.throws(() => validarImagem("../../etc/passwd"));
});

test("validarImagem: recusa SSRF (loopback, privado, link-local, credenciais)", () => {
  assert.throws(() => validarImagem("http://127.0.0.1/x.jpg"));
  assert.throws(() => validarImagem("http://localhost/x.jpg"));
  assert.throws(() => validarImagem("http://10.0.0.5/x.jpg"));
  assert.throws(() => validarImagem("http://169.254.169.254/latest/meta-data"));
  assert.throws(() => validarImagem("https://user:pass@exemplo.com/x.jpg"));
  assert.throws(() => validarImagem("ftp://exemplo.com/x.jpg"));
});

test("validarImagem: recusa data URI que não é imagem", () => {
  assert.throws(() => validarImagem("data:text/html;base64,PHNjcmlwdD4="));
});

test("envio: se o sendMedia falhar, reenvia só o texto (não perde a oferta)", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");
  const { enviarParaGrupo } = await import("./dispatch.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [{ instancia: "inst-teste", nome: "Teste", ativo: true, peso: 1, principal: true, enviadas: 0, ultimaEm: null, criadaEm: "" }],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  let media = 0;
  let texto = 0;
  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) return new Response(JSON.stringify({ instance: { state: "open" } }), { headers: { "content-type": "application/json" } });
    if (url.includes("cdn.exemplo.com")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    if (url.includes("/message/sendMedia/")) { media++; return new Response(JSON.stringify({ status: 500 }), { status: 500 }); }
    if (url.includes("/message/sendText/")) { texto++; return new Response(JSON.stringify({ key: { id: "txt-1" } }), { headers: { "content-type": "application/json" } }); }
    throw new Error(`url inesperada: ${url}`);
  });
  try {
    const r = await enviarParaGrupo({
      grupo: "120363000000000000@g.us",
      imagem: "https://cdn.exemplo.com/foto.jpg",
      legenda: "oferta",
      dryRun: false,
    });
    assert.equal(r.messageId, "txt-1");
    assert.equal(media, 3, "sendMedia deve esgotar as tentativas");
    assert.equal(texto, 1, "depois do media, envia o texto uma vez");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: fluxo sem número permitido falha antes de chamar a Evolution", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-perm-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [{
      instancia: "inst-monitor", nome: "Monitor", ativo: true, peso: 1,
      enviadas: 0, ultimaEm: null, criadaEm: "",
      permissoes: { piloto: false, monitor: true, disparo: false }, pausado: false,
    }],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) {
      return new Response(JSON.stringify({ instance: { state: "open" } }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`não deveria chamar a Evolution: ${url}`);
  });
  try {
    await assert.rejects(
      () => enviarParaGrupo({ grupo: "120363@g.us", legenda: "x", dryRun: false, fluxo: "disparo" }),
      /Nenhum número ativo e permitido para o fluxo "disparo"/
    );
    assert.equal(m.chamadas.filter((u) => u.includes("/message/")).length, 0);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Instância de teste no formato do cadastro (data/instancias.json). */
function inst(
  nome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    instancia: nome,
    nome,
    ativo: true,
    peso: 1,
    principal: false,
    enviadas: 0,
    ultimaEm: null,
    criadaEm: "",
    permissoes: { piloto: true, monitor: true, disparo: true },
    pausado: false,
    ...extra,
  };
}

test("dispatch: instância fixada válida é a que envia (issue #45)", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-fixa-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [inst("inst-fixa-45"), inst("inst-auto-45")],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) {
      return new Response(JSON.stringify({ instance: { state: "open" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/message/sendText/inst-fixa-45")) {
      return new Response(JSON.stringify({ key: { id: "fixa-1" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`url inesperada: ${url}`);
  });
  try {
    const { enviarParaGrupo } = await import("./dispatch.js");
    const r = await enviarParaGrupo({
      grupo: "5511999990001@s.whatsapp.net",
      legenda: "oferta",
      dryRun: false,
      fluxo: "disparo",
      instancia: "inst-fixa-45",
    });
    assert.equal(r.messageId, "fixa-1");
    const enviados = m.chamadas.filter((u) => u.includes("/message/sendText/"));
    assert.equal(enviados.length, 1);
    assert.ok(enviados[0].includes("inst-fixa-45"), "a fixada tem que ser a remetente");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: instância fixada inválida (pausada) cai no automático com aviso", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-fixa-pausa-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [inst("inst-pausada-45", { pausado: true }), inst("inst-livre-45")],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) {
      return new Response(JSON.stringify({ instance: { state: "open" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/message/sendText/inst-livre-45")) {
      return new Response(JSON.stringify({ key: { id: "auto-1" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`url inesperada: ${url}`);
  });
  const logs: string[] = [];
  const logOriginal = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const { enviarParaGrupo } = await import("./dispatch.js");
    const r = await enviarParaGrupo({
      grupo: "5511999990002@s.whatsapp.net",
      legenda: "oferta",
      dryRun: false,
      fluxo: "disparo",
      instancia: "inst-pausada-45",
    });
    assert.equal(r.messageId, "auto-1", "a fixada pausada não pode enviar");
    const aviso = logs.find((l) => l.includes("instância fixada inst-pausada-45 inválida"));
    assert.ok(aviso, `esperado aviso de instância fixada inválida; logs: ${logs.join(" | ")}`);
    assert.ok(aviso!.includes("usando automático"), "o aviso precisa dizer que usa o automático");
    assert.ok(aviso!.includes("fluxo disparo"), "o aviso precisa citar o fluxo");
  } finally {
    console.log = logOriginal;
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: instância fixada sem permissão Disparo não é usada", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-fixa-perm-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [
      inst("inst-sem-perm-45", { permissoes: { piloto: true, monitor: true, disparo: false } }),
      inst("inst-com-perm-45"),
    ],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) {
      return new Response(JSON.stringify({ instance: { state: "open" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/message/sendText/inst-com-perm-45")) {
      return new Response(JSON.stringify({ key: { id: "perm-1" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`url inesperada: ${url}`);
  });
  try {
    const { enviarParaGrupo } = await import("./dispatch.js");
    const r = await enviarParaGrupo({
      grupo: "5511999990003@s.whatsapp.net",
      legenda: "oferta",
      dryRun: false,
      fluxo: "disparo",
      instancia: "inst-sem-perm-45",
    });
    assert.equal(r.messageId, "perm-1");
    const enviados = m.chamadas.filter((u) => u.includes("/message/sendText/"));
    assert.ok(enviados.every((u) => !u.includes("inst-sem-perm-45")));
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: fluxo permitido envia normalmente", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mockFetch } = await import("../monitor/test-utils.js");

  const dir = mkdtempSync(join(tmpdir(), "alcance-dispatch-ok-"));
  writeFileSync(join(dir, "instancias.json"), JSON.stringify({
    itens: [{
      instancia: "inst-piloto", nome: "Piloto", ativo: true, peso: 1,
      enviadas: 0, ultimaEm: null, criadaEm: "",
      permissoes: { piloto: true, monitor: false, disparo: false }, pausado: false,
    }],
  }));
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";

  const m = mockFetch(async (url) => {
    if (url.includes("/instance/connectionState/")) {
      return new Response(JSON.stringify({ instance: { state: "open" } }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/message/sendText/inst-piloto")) {
      return new Response(JSON.stringify({ key: { id: "ok-1" } }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`url inesperada: ${url}`);
  });
  try {
    const r = await enviarParaGrupo({ grupo: "120363@g.us", legenda: "x", dryRun: false, fluxo: "piloto" });
    assert.equal(r.messageId, "ok-1");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
