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
  process.env.EVO_URL = "http://evo.test";
  process.env.EVO_KEY = "k";
  process.env.EVO_INSTANCE = "inst-teste";
  // janela comercial sempre aberta (teste não depende do horário)
  process.env.MONITOR_JANELA = "0";
  process.env.JANELA_INICIO = "0";
  process.env.JANELA_FIM = "24";
  const mod = await import(`./clientes.js?v=${Math.random()}`);
  const fila = await import(`./fila.js?v=${Math.random()}`);
  const broker = await import(`../messaging/broker.js?v=${Math.random()}`);
  return { mod, fila, broker, dir };
}

/** Mock da Evolution: estado "open" + sendText com sucesso ou falha. */
function mockEvolution(op: { falhar?: boolean; status?: number; corpo?: string } = {}) {
  return mockFetch(async (url: string) => {
    if (url.includes("/instance/connectionState/")) {
      return resJson({ instance: { state: "open" } });
    }
    if (url.includes("/message/sendText/")) {
      if (op.falhar) {
        // "Connection Closed" = transitório (retry); "invalid number" = permanente (DLQ)
        return new Response(op.corpo ?? "Connection Closed", { status: op.status ?? 500 });
      }
      return resJson({ key: { id: "msg-teste" } });
    }
    return resJson({});
  });
}

/**
 * Lê os itens da fila gravados em data/messaging/cliente.enviar.json.
 *
 * From issue #49 a fila de campanhas é uma fila de Mensageria: cada item é um
 * envelope `cliente.enviar` e o payload é o item da campanha.
 */
function lerItensFila(dir: string): any[] {
  const raw = JSON.parse(readFileSync(join(dir, "messaging", "cliente.enviar.json"), "utf8"));
  return Array.isArray(raw) ? raw.map((e: any) => e?.payload) : [];
}

const GRUPOS = [
  { id: "g1@g.us", subject: "Grupo Um" },
  { id: "g2@g.us", subject: "Grupo Dois" },
  { id: "g3@g.us", subject: "Grupo Três" },
];

test("fila: o item carrega o número escolhido na campanha (issue #45)", async () => {
  const { mod, dir } = await carregarFila();
  try {
    await mod.enfileirarCampanha({
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
    await mod.enfileirarCampanha({
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
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000003@s.whatsapp.net"],
      disparoId: "disp-3",
      instancia: "inst-antigo",
    });
    const n = await mod.atualizarItensDaFila("disp-3", {
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

// ---------- issue #49: ACK real, retry com backoff e DLQ ----------

test("fila: ACK — o item só sai da fila depois do envio com sucesso", async () => {
  const { mod, dir } = await carregarFila();
  const m = mockEvolution();
  try {
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000010@s.whatsapp.net"],
      disparoId: "disp-ack",
    });
    assert.equal(mod.estadoFilaClientes().pendentes, 1);
    const item = await mod.liberarProximoCliente();
    assert.ok(item, "o worker processa o item");
    assert.equal(mod.estadoFilaClientes().pendentes, 0, "a fila esvazia só depois do ACK");
    assert.equal(mod.estadoFilaClientes().enviados, 1, "o contador de processadas aumenta");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: falha transitória devolve o item à fila (a mensagem NÃO se perde)", async () => {
  const { mod, fila, dir } = await carregarFila();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000011@s.whatsapp.net"],
      disparoId: "disp-retry",
    });
    await mod.liberarProximoCliente();
    assert.equal(mod.estadoFilaClientes().pendentes, 1, "o item continua na fila");
    const env = fila.pendentes()[0];
    assert.equal(env.tentativas, 1, "tentativas incremented");
    assert.ok(env.ultimoErro, "o último erro fica registrado");
    assert.ok(env.proximaTentativaEm, "a próxima tentativa é agendada");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: retry tem backoff exponencial com jitter, dentro do teto", async () => {
  const { mod, fila, dir } = await carregarFila();
  const m = mockEvolution({ falhar: true, status: 500 });
  try {
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000012@s.whatsapp.net"],
      disparoId: "disp-backoff",
    });
    await mod.liberarProximoCliente();
    const env = fila.pendentes()[0];
    const atraso = Date.parse(env.proximaTentativaEm!) - Date.now();
    const base = Number(process.env.MENSAGERIA_RETRY_BASE_MS ?? 30_000);
    assert.ok(atraso > 0, "a próxima tentativa é no futuro");
    assert.ok(atraso <= base * 1.2, `atraso ${atraso}ms dentro do teto (base ${base}ms + jitter)`);
    // 2ª tentativa: dobra (60s ± 20%) e continua dentro do teto
    const politica = await import(`../messaging/politica.js?v=${Math.random()}`);
    const i2 = politica.intervaloRetry(2);
    const i1 = politica.intervaloRetry(1);
    assert.ok(i2 > i1, `o backoff cresce (${i1}ms -> ${i2}ms)`);
    assert.ok(i2 <= 60_000 * 1.2, `2ª tentativa dentro do teto (${i2}ms)`);
    const teto = politica.intervaloRetry(50);
    assert.ok(teto <= 1_800_000, `o teto de 30 min vale (${teto}ms)`);
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: erro permanente vai direto para a DLQ (sem retry)", async () => {
  const { mod, broker, dir } = await carregarFila();
  const m = mockEvolution({ falhar: true, status: 400, corpo: "invalid number" });
  try {
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000013@s.whatsapp.net"],
      disparoId: "perm-1",
    });
    await mod.liberarProximoCliente();
    assert.equal(mod.estadoFilaClientes().pendentes, 0, "o item não fica na fila");
    const dlq = broker.getBroker().dlq("cliente.enviar");
    assert.equal(dlq.length, 1, "o item foi para a DLQ");
    assert.match(dlq[0].motivo, /não transitório/);
    assert.ok(dlq[0].ultimoErro, "a DLQ guarda o motivo do erro");
    assert.ok(dlq[0].tentativas >= 1);
    assert.equal(dlq[0].origem, "perm-1", "a DLQ guarda a origem (disparo)");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: reprocessar devolve o item da DLQ para a fila", async () => {
  const { mod, broker, dir } = await carregarFila();
  const m = mockEvolution({ falhar: true, status: 400, corpo: "invalid number" });
  try {
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000014@s.whatsapp.net"],
      disparoId: "perm-2",
    });
    await mod.liberarProximoCliente();
    const dlq = broker.getBroker().dlq("cliente.enviar");
    assert.equal(dlq.length, 1);
    await broker.getBroker().reprocessar(dlq[0].id);
    assert.equal(broker.getBroker().dlq("cliente.enviar").length, 0, "o item sai da DLQ");
    assert.equal(mod.estadoFilaClientes().pendentes, 1, "e volta para a fila");
  } finally {
    m.restaurar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: crash não perde mensagem — reserva antiga volta para a fila", async () => {
  const { mod, fila, broker, dir } = await carregarFila();
  try {
    await mod.enfileirarCampanha({
      texto: "oferta",
      jids: ["5511900000015@s.whatsapp.net"],
      disparoId: "crash-1",
    });
    // simula o crash: item reservado há mais de 5 minutos
    const env = (await fila.reservarProximo())!;
    const antigo = { ...env, reservadoEm: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    await broker.getBroker().atualizar!(env.id, antigo);
    const liberados = await fila.liberarReservasAntigas();
    assert.equal(liberados, 1, "a reserva abandonada é liberada");
    const livre = fila.pendentes()[0];
    assert.equal(livre.emAndamento, undefined, "o item volta para a fila (sem reserva)");
    assert.equal(mod.estadoFilaClientes().pendentes, 1, "nenhum item foi perdido");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: migração do store legado não perde item pendente", async () => {
  const { fila, dir } = await carregarFila();
  try {
    writeFileSync(
      join(dir, "clientes-fila.json"),
      JSON.stringify({
        itens: [
          { id: "leg-a", jid: "5511900000016@s.whatsapp.net", nome: "A", texto: "oi", criadoEm: new Date().toISOString() },
          { id: "leg-b", jid: "5511900000017@s.whatsapp.net", nome: "B", texto: "oi", criadoEm: new Date().toISOString() },
        ],
        ultimoEnvio: null,
        enviados: 0,
        erros: 0,
        pausado: false,
      })
    );
    const n = await fila.migrarLegadoSeNecessario();
    assert.equal(n, 2, "os 2 itens pendentes foram migrados");
    assert.equal(fila.totalPendentes(), 2);
    // idempotente: não duplica
    const n2 = await fila.migrarLegadoSeNecessario();
    assert.equal(n2, 0);
    assert.equal(fila.totalPendentes(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fila: o estado legado (enviados/erros/pausa) é herdado sem perder histórico", async () => {
  const { mod, fila, dir } = await carregarFila();
  try {
    writeFileSync(
      join(dir, "clientes-fila.json"),
      JSON.stringify({
        itens: [],
        ultimoEnvio: "2026-11-11T16:06:28.389Z",
        enviados: 254,
        erros: 206,
        pausado: true,
      })
    );
    const st = fila.estado();
    assert.equal(st.enviados, 254, "o contador histórico é preservado");
    assert.equal(st.erros, 206);
    assert.equal(st.pausado, true);
    assert.equal(mod.estadoFilaClientes().enviados, 254);
    assert.equal(mod.estadoFilaClientes().pausado, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
