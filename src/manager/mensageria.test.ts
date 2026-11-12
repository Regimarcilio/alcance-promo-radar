/**
 * Testes da API de Mensageria (issue #54).
 *
 * Sobe o **manager de verdade** (processo separado, estado temporário) e
 * fala com ele por HTTP — assim o gate *default-deny* é testado como ele é
 * (401 sem sessão, `MANAGER_KEY` como credencial de máquina).
 *
 * Nada de envio real: o manager sobe em `ALCANCE_SMOKE=1` (sem workers) e
 * a Evolution API não é tocada.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Raiz do projeto (o teste roda compilado em dist/). */
function raizProjeto(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "manager", "server.ts"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("raiz do projeto não encontrada");
}

const RAIZ = raizProjeto();
const CHAVE = "chave-de-teste-mensageria";

let dir: string;
let filho: ChildProcess | null = null;
let porta = 0;

/** Porta livre (evita colisão com o manager de produção na 8091). */
function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });
}

function envelope(
  id: string,
  tipo: string,
  correlationId: string,
  chave: string | null,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    tipo,
    versao: 1,
    timestamp: "2026-11-12T02:00:00.000Z",
    correlationId,
    ...(chave ? { chave } : {}),
    tentativas: 3,
    payload,
    ultimoErro: "Connection Closed",
    ...extra,
  };
}

function itemDlq(
  id: string,
  tipo: string,
  correlationId: string,
  chave: string | null,
  payload: unknown,
  motivo: string,
  ultimoErro: string,
  tentativas: number,
  origem: string,
) {
  return {
    id,
    tipo,
    envelope: envelope(id, tipo, correlationId, chave, payload, { ultimoErro, tentativas }),
    motivo,
    ultimoErro,
    tentativas,
    ultimaTentativaEm: "2026-11-12T03:00:00.000Z",
    origem,
  };
}

/** Semeia a DLQ, a fila e a auditoria no diretório temporário. */
function semear(): void {
  const msgDir = join(dir, "messaging");
  mkdirSync(msgDir, { recursive: true });

  const dlqCliente = [
    itemDlq(
      "dlq-a",
      "cliente.enviar",
      "corr-1",
      "disparo-1:5511000000001",
      { jid: "5511000000001@s.whatsapp.net", nome: "Contato 1", texto: "oferta", disparoId: "disparo-1" },
      "tentativas esgotadas",
      "Connection Closed",
      3,
      "disparo-1",
    ),
    itemDlq(
      "dlq-b",
      "cliente.enviar",
      "corr-2",
      "disparo-2:5511000000002",
      { jid: "5511000000002@s.whatsapp.net", nome: "Contato 2", texto: "oferta", disparoId: "disparo-2" },
      "erro não transitório",
      "número não existe no WhatsApp (404 not found)",
      1,
      "disparo-2",
    ),
    itemDlq(
      "dlq-d",
      "cliente.enviar",
      "corr-4",
      "disparo-4:5511000000004",
      { jid: "5511000000004@s.whatsapp.net", nome: "Contato 4", texto: "oferta", disparoId: "disparo-4" },
      "tentativas esgotadas",
      "ETIMEDOUT ao falar com a Evolution API",
      3,
      "disparo-4",
    ),
  ];
  writeFileSync(join(msgDir, "dlq-cliente.enviar.json"), JSON.stringify(dlqCliente, null, 2));

  const dlqMonitor = [
    itemDlq(
      "dlq-c",
      "monitor.encaminhar",
      "corr-3",
      null,
      {
        item: {
          id: "mlb-1",
          origem: "Grupo Origem",
          programa: "mercadolivre",
          idProduto: "MLB-1",
          link: "https://exemplo.invalid/p/MLB-1",
          mensagem: "oferta",
          destinos: ["Grupo Destino"],
          criadoEm: "2026-11-12T02:00:00.000Z",
        },
        destino: "Grupo Destino",
      },
      "tentativas esgotadas",
      "Connection Closed",
      3,
      "Grupo Origem",
    ),
  ];
  writeFileSync(join(msgDir, "dlq-monitor.encaminhar.json"), JSON.stringify(dlqMonitor, null, 2));

  // fila de clientes com um item pendente (para medir o "+1")
  writeFileSync(
    join(msgDir, "cliente.enviar.json"),
    JSON.stringify([
      envelope(
        "pend-1",
        "cliente.enviar",
        "corr-0",
        "disparo-0:5511000000000",
        { jid: "5511000000000@s.whatsapp.net", nome: "Contato 0", texto: "oferta", disparoId: "disparo-0" },
        { tentativas: 0 },
      ),
    ]),
  );

  // auditoria: eventos de duas correlações diferentes
  writeFileSync(
    join(dir, "auditoria-mensageria.json"),
    JSON.stringify(
      [
        { em: "2026-11-12T02:10:00.000Z", registro: "evento", tipo: "oferta.recebida", id: "e1", correlationId: "corr-1", chave: "oferta.recebida:e1", tentativas: 0 },
        { em: "2026-11-12T02:11:00.000Z", registro: "evento", tipo: "disparo.criado", id: "e2", correlationId: "corr-2", chave: "disparo.criado:e2", tentativas: 0 },
        { em: "2026-11-12T02:12:00.000Z", registro: "evento", tipo: "oferta.recebida", id: "e3", correlationId: "corr-3", chave: "oferta.recebida:e3", tentativas: 0 },
      ],
      null,
      2,
    ),
  );
}

async function api(
  caminho: string,
  op: { metodo?: string; corpo?: unknown; chave?: string | null } = {},
): Promise<{ status: number; corpo: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const chave = op.chave === undefined ? CHAVE : op.chave;
  if (chave) headers["x-manager-key"] = chave;
  const r = await fetch(`http://127.0.0.1:${porta}${caminho}`, {
    method: op.metodo ?? "GET",
    headers,
    body: op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
  });
  const texto = await r.text();
  let corpo: any = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = texto;
  }
  return { status: r.status, corpo };
}

function lerJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function filaCliente(): any[] {
  return lerJson(join(dir, "messaging", "cliente.enviar.json")) ?? [];
}

function dlqCliente(): any[] {
  return lerJson(join(dir, "messaging", "dlq-cliente.enviar.json")) ?? [];
}

function auditoria(): any[] {
  return lerJson(join(dir, "auditoria-mensageria.json")) ?? [];
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "alcance-mensageria-"));
  // usuário do painel (o manager exige pelo menos um usuário ativo)
  const r = spawnSync(
    process.execPath,
    [join(RAIZ, "scripts", "auth-user.mjs"), "admin", "--telefone", "5511999999999"],
    {
      env: { ...process.env, ALCANCE_DATA_DIR: dir, AUTH_PASSWORD: "senha-de-teste-123" },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`auth-user falhou: ${r.stderr || r.stdout}`);
  semear();

  porta = await portaLivre();
  filho = spawn(process.execPath, [join(RAIZ, "dist", "manager", "server.js")], {
    env: {
      ...process.env,
      ALCANCE_DATA_DIR: dir,
      ALCANCE_SMOKE: "1",
      MANAGER_PORT: String(porta),
      MANAGER_KEY: CHAVE,
      SESSION_SECRET: "segredo-de-teste-".padEnd(48, "x"),
      WEBHOOK_KEY: "webhook-de-teste-123456",
      AUTH_PASSWORD: "senha-de-teste-123",
      AUTH_TTL_HORAS: "1",
      AUTH_IDLE_MIN: "5",
      AUTH_COOKIE_SECURE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pronto = await new Promise<boolean>((resolve) => {
    let tentativas = 0;
    const timer = setInterval(async () => {
      tentativas++;
      try {
        const resp = await fetch(`http://127.0.0.1:${porta}/healthz`);
        if (resp.ok) {
          clearInterval(timer);
          resolve(true);
        }
      } catch {
        /* ainda subindo */
      }
      if (tentativas > 150) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
  if (!pronto) throw new Error("manager não subiu no smoke");
});

after(() => {
  if (filho) {
    filho.kill("SIGTERM");
    filho = null;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("default-deny: sem sessão e sem MANAGER_KEY as rotas da Mensageria são 401", async () => {
  for (const rota of ["/api/mensageria/stats", "/api/mensageria/filas", "/api/mensageria/dlq", "/api/mensageria/eventos"]) {
    const r = await api(rota, { chave: null });
    assert.equal(r.status, 401, `${rota} sem credencial deveria ser 401`);
  }
  const post1 = await api("/api/mensageria/dlq/reprocessar", { metodo: "POST", corpo: { id: "dlq-a" }, chave: null });
  assert.equal(post1.status, 401, "reprocessar sem credencial deveria ser 401");
  const post2 = await api("/api/mensageria/dlq/descartar", { metodo: "POST", corpo: { id: "dlq-a" }, chave: null });
  assert.equal(post2.status, 401, "descartar sem credencial deveria ser 401");
  const post3 = await api("/api/mensageria/dlq/reprocessar-lote", { metodo: "POST", corpo: { tipo: "cliente.enviar" }, chave: null });
  assert.equal(post3.status, 401, "reprocessar-lote sem credencial deveria ser 401");
  // MANAGER_KEY errada também é 401 (comparação em tempo constante)
  const errada = await api("/api/mensageria/dlq", { chave: "chave-errada" });
  assert.equal(errada.status, 401, "MANAGER_KEY errada deveria ser 401");
});

test("com MANAGER_KEY as rotas respondem 200 com o snapshot real", async () => {
  const stats = await api("/api/mensageria/stats");
  assert.equal(stats.status, 200);
  assert.ok(Array.isArray(stats.corpo.filas));
  const dlq = await api("/api/mensageria/dlq");
  assert.equal(dlq.status, 200);
  assert.equal(dlq.corpo.itens.length, 4, "a DLQ semeada tem 4 itens");
  const eventos = await api("/api/mensageria/eventos");
  assert.equal(eventos.status, 200);
  assert.equal(eventos.corpo.eventos.length, 3);
  assert.ok(Array.isArray(eventos.corpo.assinantes));
});

test("reprocessar item: ele sai da DLQ e volta para a fila com tentativas zeradas", async () => {
  const antes = filaCliente().length;
  const r = await api("/api/mensageria/dlq/reprocessar", { metodo: "POST", corpo: { id: "dlq-a" } });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.ok, true);

  assert.equal(dlqCliente().some((i) => i.id === "dlq-a"), false, "o item saiu da DLQ");
  const fila = filaCliente();
  assert.equal(fila.length, antes + 1, "a fila ganhou 1 pendente");
  const env = fila.find((e) => e.id === "dlq-a");
  assert.ok(env, "o envelope voltou para a fila");
  assert.equal(env.tentativas, 0, "as tentativas foram zeradas");
  assert.equal(env.ultimoErro, "Connection Closed", "o último erro foi preservado para auditoria");
  assert.equal(env.reprocessos, 1, "o contador de reprocessos foi incrementado");

  const acao = auditoria().find((e) => e.registro === "acao" && e.id === "dlq-a");
  assert.ok(acao, "a ação foi registrada na auditoria");
  assert.equal(acao.acao, "reprocessar");
  assert.equal(acao.tipo, "cliente.enviar");
  assert.equal(acao.chave, "disparo-1:5511000000001");
  assert.equal(acao.motivo, "tentativas esgotadas");
  assert.equal(acao.correlationId, "corr-1");
});

test("descartar: o item sai da DLQ e NÃO volta para a fila (destrutivo + auditoria)", async () => {
  const antes = filaCliente().length;
  const r = await api("/api/mensageria/dlq/descartar", { metodo: "POST", corpo: { id: "dlq-b" } });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.ok, true);
  assert.equal(dlqCliente().some((i) => i.id === "dlq-b"), false, "o item saiu da DLQ");
  assert.equal(filaCliente().length, antes, "a fila não mudou (descartar não reenfileira)");
  assert.equal(filaCliente().some((e) => e.id === "dlq-b"), false, "o item não voltou para a fila");

  const acao = auditoria().find((e) => e.registro === "acao" && e.id === "dlq-b");
  assert.ok(acao, "a ação destrutiva foi registrada na auditoria");
  assert.equal(acao.acao, "descartar");
  assert.equal(acao.motivo, "erro não transitório");
  assert.equal(acao.correlationId, "corr-2");
  assert.equal(acao.chave, "disparo-2:5511000000002");
});

test("reprocessar-lote com filtro por tipo: só os itens daquele tipo voltam", async () => {
  const r = await api("/api/mensageria/dlq/reprocessar-lote", {
    metodo: "POST",
    corpo: { tipo: "monitor.encaminhar" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.total, 1, "apenas o item do monitor foi reprocessado");
  assert.equal(dlqCliente().some((i) => i.id === "dlq-d"), true, "o item de outro tipo continua na DLQ");

  const monitor = lerJson(join(dir, "monitor-fila.json"));
  const item = (monitor?.itens ?? []).find((i: any) => i.id === "mlb-1");
  assert.ok(item, "o item do monitor voltou para a fila dele");
  assert.equal(item.tentativas, 0);
  assert.equal(item.reprocessos, 1);
});

test("reprocessar-lote sem filtro: reprocessa o que sobrou na DLQ", async () => {
  const restantes = dlqCliente().length;
  assert.equal(restantes, 1, "sobrou 1 item na DLQ");
  const antes = await api("/api/mensageria/stats");
  const r = await api("/api/mensageria/dlq/reprocessar-lote", { metodo: "POST", corpo: {} });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.total, 1);
  assert.equal(dlqCliente().length, 0, "a DLQ ficou limpa");
  assert.equal(filaCliente().some((e) => e.id === "dlq-d"), true, "o item voltou para a fila");

  // O lote só REENFILEIRA: nada foi enviado (o contador de processadas não
  // muda) e o pendente entra na fila para o worker seguir o ritmo normal.
  const depois = await api("/api/mensageria/stats");
  const filaAntes = antes.corpo.filas.find((f: any) => f.tipo === "cliente.enviar");
  const filaDepois = depois.corpo.filas.find((f: any) => f.tipo === "cliente.enviar");
  assert.equal(filaDepois.processadas, filaAntes.processadas, "o lote não processou/enviou nada");
  assert.equal(filaDepois.pendentes, filaAntes.pendentes + 1, "o item foi reenfileirado");
  assert.equal(filaDepois.dlq, 0, "a DLQ esvaziou");
});

test("filtro por correlationId em /api/mensageria/eventos (trilha de correlação)", async () => {
  const r = await api("/api/mensageria/eventos?correlationId=corr-2");
  assert.equal(r.status, 200);
  assert.equal(r.corpo.eventos.length, 1, "só o evento da correlação pedida");
  assert.equal(r.corpo.eventos[0].correlationId, "corr-2");
  assert.ok(Array.isArray(r.corpo.acoes), "as ações do operador vêm separadas dos eventos");
  const todas = await api("/api/mensageria/eventos");
  assert.equal(todas.corpo.eventos.length, 3, "sem filtro volta a lista toda");
});
