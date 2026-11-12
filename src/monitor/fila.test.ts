/** Testes da fila do monitor: reenfileirar preserva a oferta (não perde no rate limit). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch, resJson } from "./test-utils.js";

async function carregarFila() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-fila-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./fila.js?v=${Math.random()}`);
  return { mod, dir };
}

const ITEM = {
  origem: "120363@g.us",
  programa: "mercadolivre",
  idProduto: "MLB123",
  link: "https://x",
  mensagem: "oi",
  imagem: "",
  destinos: ["120363999@g.us"],
};

test("fila: reenfileirar devolve o MESMO item (id preservado)", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar(ITEM);
    // simula o item ter sido retirado da fila (liberado) e devolvido
    const s = JSON.parse(readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    s.itens = [];
    const fs = await import("node:fs");
    fs.writeFileSync(join(dir, "monitor-fila.json"), JSON.stringify(s, null, 2));

    const devolvido = mod.reenfileirar({ ...criado, tentativas: 1 });
    assert.equal(devolvido.id, criado.id, "o id tem que ser o mesmo (a oferta não pode duplicar)");
    const salvo = JSON.parse(readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    assert.equal(salvo.itens.length, 1);
    assert.equal(salvo.itens[0].id, criado.id);
    assert.equal(salvo.itens[0].tentativas, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: reenfileirar não duplica o mesmo item", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar(ITEM);
    mod.reenfileirar(criado);
    mod.reenfileirar(criado);
    const salvo = JSON.parse(readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    assert.equal(salvo.itens.length, 1, "não pode duplicar o mesmo item na fila");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: reenfileirar preserva os destinos restantes", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar({ ...ITEM, destinos: ["a@g.us", "b@g.us"] });
    const devolvido = mod.reenfileirar({ ...criado, destinos: ["b@g.us"], tentativas: 1 });
    assert.deepEqual(devolvido.destinos, ["b@g.us"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: recuperarEmAndamento devolve item interrompido no boot", async () => {
  const { mod, dir } = await carregarFila();
  try {
    const criado = mod.enfileirar(ITEM);
    const fs = await import("node:fs");
    const s = JSON.parse(fs.readFileSync(join(dir, "monitor-fila.json"), "utf8"));
    s.itens = [];
    s.emAndamento = { item: criado, desde: new Date().toISOString() };
    fs.writeFileSync(join(dir, "monitor-fila.json"), JSON.stringify(s, null, 2));

    assert.equal(mod.tamanhoFila(), 0);
    assert.equal(mod.recuperarEmAndamento(), 1);
    assert.equal(mod.tamanhoFila(), 1);
    assert.equal(mod.itensFila()[0].id, criado.id);
    assert.equal(mod.recuperarEmAndamento(), 0, "não duplica na segunda chamada");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- issue #49: ACK, retry e DLQ na fila do Monitor ----------

/** Prepara o data dir do Monitor com autoEnviar ligado. */
async function carregarFilaMonitor() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-fila-mon-"));
  writeFileSync(
    join(dir, "monitor.json"),
    JSON.stringify({ regras: [], autoEnviar: true, foto: "origem", criadoEm: new Date().toISOString() })
  );
  process.env.ALCANCE_DATA_DIR = dir;
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  const mod = await import(`./fila.js?v=${Math.random()}`);
  return { mod, dir };
}

/** Mock da Evolution (estado open + sendText). */
function mockEvolution(op: { falhar?: boolean; status?: number; corpo?: string } = {}) {
  return mockFetch(async (url: string) => {
    if (url.includes("/instance/connectionState/")) {
      return resJson({ instance: { state: "open" } });
    }
    if (url.includes("/message/sendText/")) {
      if (op.falhar) {
        return new Response(op.corpo ?? "Connection Closed", { status: op.status ?? 500 });
      }
      return resJson({ key: { id: "msg-mon" } });
    }
    return resJson({});
  });
}

test("fila do monitor: ACK — o item só sai da fila depois do envio com sucesso", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution();
  try {
    mod.enfileirar(ITEM);
    assert.equal(mod.tamanhoFila(), 1);
    await mod.liberarProximo();
    assert.equal(mod.tamanhoFila(), 0, "a fila esvazia só depois do ACK");
    assert.equal(mod.statsMonitor().processadas, 1);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: falha transitória reenfileira sem duplicar o item em andamento", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    const criado = mod.enfileirar(ITEM);
    await mod.liberarProximo();
    assert.equal(mod.tamanhoFila(), 1, "o item continua na fila");
    assert.equal(mod.itensFila().length, 1, "não duplica o item em andamento");
    assert.equal(mod.itensFila()[0].id, criado.id, "é o MESMO item");
    assert.equal(mod.itensFila()[0].tentativas, 1, "as tentativas contam");
    assert.equal(mod.emAndamento(), null, "o item não fica em andamento");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: erro permanente vai para a DLQ com o motivo", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 400, corpo: "invalid number" });
  try {
    mod.enfileirar(ITEM);
    await mod.liberarProximo();
    const dlq = mod.dlqMonitor();
    assert.equal(dlq.length, 1, "o destino que falhou foi para a DLQ");
    assert.match(dlq[0].motivo, /não transitório/);
    assert.ok(dlq[0].ultimoErro);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: tentativas esgotadas vão para a DLQ", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    const criado = mod.enfileirar(ITEM);
    // já falhou 3 vezes (o limite atual do Monitor)
    mod.reenfileirar({ ...criado, tentativas: 3 });
    await mod.liberarProximo();
    const dlq = mod.dlqMonitor();
    assert.equal(dlq.length, 1, "vai para a DLQ");
    assert.match(dlq[0].motivo, /tentativas esgotadas/);
    assert.equal(dlq[0].tentativas, 4);
    assert.equal(mod.tamanhoFila(), 0, "sai da fila");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: reprocessar devolve o item da DLQ para a fila", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    const criado = mod.enfileirar(ITEM);
    mod.reenfileirar({ ...criado, tentativas: 3 });
    await mod.liberarProximo();
    assert.equal(mod.dlqMonitor().length, 1);
    const ok = mod.reprocessarDlq(mod.dlqMonitor()[0].id);
    assert.equal(ok, true);
    assert.equal(mod.dlqMonitor().length, 0, "sai da DLQ");
    assert.equal(mod.tamanhoFila(), 1, "volta para a fila");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- issue #78: reenvio de duplicatas (+24h, pela fila) ----------

/** Libera o ritmo da fila do Monitor (o intervalo entre liberações). */
function liberarRitmoMonitor(dir: string): void {
  const arq = join(dir, "monitor-fila.json");
  const raw = JSON.parse(readFileSync(arq, "utf8"));
  raw.ultimoEnvio = null;
  writeFileSync(arq, JSON.stringify(raw, null, 2));
}

/** Valor de um contador da Mensageria (mesmo módulo do processo). */
async function contador(nome: string, labels?: Record<string, string>): Promise<number> {
  const contadores = await import("../messaging/contadores.js");
  return contadores.valorContador(nome, labels);
}

/** Isola os switches do reenvio (restaura no fim do teste). */
function guardarSwitches() {
  const antes = {
    ativo: process.env.MENSAGERIA_REENVIO_DUP_ATIVO,
    horas: process.env.MENSAGERIA_REENVIO_DUP_HORAS,
    tipos: process.env.MENSAGERIA_REENVIO_DUP_TIPOS,
  };
  return {
    restaurar() {
      for (const [k, v] of Object.entries({
        MENSAGERIA_REENVIO_DUP_ATIVO: antes.ativo,
        MENSAGERIA_REENVIO_DUP_HORAS: antes.horas,
        MENSAGERIA_REENVIO_DUP_TIPOS: antes.tipos,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

test("fila do monitor: a oferta já encaminhada é reagendada para 24h depois do lançamento", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution();
  const sw = guardarSwitches();
  try {
    process.env.MENSAGERIA_REENVIO_DUP_ATIVO = "1";
    process.env.MENSAGERIA_REENVIO_DUP_HORAS = "24";
    process.env.MENSAGERIA_REENVIO_DUP_TIPOS = "cliente.enviar,monitor.encaminhar";

    // 1ª oferta: encaminhada (registra a chave de negócio junto do ACK)
    mod.enfileirar(ITEM);
    await mod.liberarProximo();
    const enviados = m.chamadas.filter((u) => u.includes("/message/sendText/")).length;
    assert.equal(enviados, 1);
    assert.equal(mod.tamanhoFila(), 0);

    // 2ª vez a MESMA oferta → duplicata
    mod.enfileirar(ITEM);
    liberarRitmoMonitor(dir);
    const antes = await contador("alcance_msg_duplicatas_reagendadas_total", { tipo: "monitor.encaminhar" });
    await mod.liberarProximo();

    assert.equal(
      m.chamadas.filter((u) => u.includes("/message/sendText/")).length,
      1,
      "a duplicata não é enviada agora",
    );
    assert.equal(mod.tamanhoFila(), 1, "o item continua na fila (sem ACK)");
    const item = mod.itensFila()[0];
    assert.ok(item.reenvio, "o item foi marcado como reenvio");
    assert.equal(item.reenvio!.originalEm, item.criadoEm, "o relógio é o lançamento original");
    assert.ok(item.reenvio!.chave.includes("MLB123"), "a chave é a da oferta (mlbId|preco|cupom)");
    assert.ok(Date.parse(item.proximaTentativaEm!) > Date.now(), "a próxima tentativa é no futuro");
    const horas = (Date.parse(item.proximaTentativaEm!) - Date.now()) / 3_600_000;
    assert.ok(horas > 23 && horas <= 24, `reagendado para ~24h (${horas.toFixed(2)}h)`);
    assert.equal(
      await contador("alcance_msg_duplicatas_reagendadas_total", { tipo: "monitor.encaminhar" }),
      antes + 1,
      "o contador de duplicatas reagendadas aumenta",
    );
  } finally {
    sw.restaurar();
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: o reenvio é enviado de fato e não se reagenda em loop", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution();
  const sw = guardarSwitches();
  try {
    process.env.MENSAGERIA_REENVIO_DUP_ATIVO = "1";
    process.env.MENSAGERIA_REENVIO_DUP_HORAS = "24";
    mod.enfileirar(ITEM);
    await mod.liberarProximo();

    mod.enfileirar(ITEM);
    liberarRitmoMonitor(dir);
    await mod.liberarProximo();
    assert.equal(mod.tamanhoFila(), 1, "a duplicata ficou reagendada");

    // o horário do reenvio chegou
    const item = mod.itensFila()[0];
    mod.reenfileirar({ ...item, proximaTentativaEm: new Date(Date.now() - 1000).toISOString() });
    liberarRitmoMonitor(dir);
    const antes = await contador("alcance_msg_reenvios_realizados_total", { tipo: "monitor.encaminhar" });
    await mod.liberarProximo();

    assert.equal(
      m.chamadas.filter((u) => u.includes("/message/sendText/")).length,
      2,
      "o reenvio foi enviado de fato",
    );
    assert.equal(
      await contador("alcance_msg_reenvios_realizados_total", { tipo: "monitor.encaminhar" }),
      antes + 1,
      "o contador de reenvios realizados aumenta",
    );
    assert.equal(mod.tamanhoFila(), 0, "o reenvio saiu da fila (ACK)");
  } finally {
    sw.restaurar();
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: com o reenvio desligado a duplicata é descartada", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution();
  const sw = guardarSwitches();
  try {
    process.env.MENSAGERIA_REENVIO_DUP_ATIVO = "0";
    mod.enfileirar(ITEM);
    await mod.liberarProximo();

    mod.enfileirar(ITEM);
    liberarRitmoMonitor(dir);
    const antes = await contador("alcance_msg_duplicadas_total", { tipo: "monitor.encaminhar" });
    await mod.liberarProximo();

    assert.equal(
      m.chamadas.filter((u) => u.includes("/message/sendText/")).length,
      1,
      "nada foi enviado (a duplicata é descartada)",
    );
    assert.equal(mod.tamanhoFila(), 0, "o item saiu da fila (descartado)");
    assert.equal(
      await contador("alcance_msg_duplicadas_total", { tipo: "monitor.encaminhar" }),
      antes + 1,
      "o contador de duplicatas (não reagendadas) aumenta",
    );
  } finally {
    sw.restaurar();
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila do monitor: o switch por tipo desliga só o Monitor (o Clientes continua reagendando)", async () => {
  const { mod, dir } = await carregarFilaMonitor();
  const m = mockEvolution();
  const sw = guardarSwitches();
  try {
    process.env.MENSAGERIA_REENVIO_DUP_ATIVO = "1";
    process.env.MENSAGERIA_REENVIO_DUP_TIPOS = "cliente.enviar";
    mod.enfileirar(ITEM);
    await mod.liberarProximo();

    mod.enfileirar(ITEM);
    liberarRitmoMonitor(dir);
    await mod.liberarProximo();
    assert.equal(mod.tamanhoFila(), 0, "no Monitor a oferta é descartada como antes");

    const reenvio = await import("../messaging/reenvio.js");
    assert.equal(reenvio.reenvioPermitido("cliente.enviar"), true, "no Clientes continua reagendando");
    assert.equal(reenvio.reenvioPermitido("monitor.encaminhar"), false, "o Monitor fica de fora");
  } finally {
    sw.restaurar();
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});
