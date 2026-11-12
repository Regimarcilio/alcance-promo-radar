/**
 * Testes do núcleo de reenvio de duplicatas (issue #78).
 *
 * Regras verificadas aqui:
 * - as horas contam a partir do **lançamento original** (não da detecção);
 * - `proximaTentativaEm` **nunca** fica no passado (rolagem para o próximo
 *   ciclo);
 * - o marcador `reenvio` preserva `correlationId` e a chave;
 * - os switches (global e por tipo) decidem se o reenvio é permitido.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agendarReenvioDuplicado,
  ehReenvioAgendado,
  horasReenvio,
  momentoReenvio,
  reenvioAtivo,
  reenvioPermitido,
  tiposComReenvio,
} from "./reenvio.js";
import { criarEnvelope, validarEnvelope } from "./envelope.js";

/** Snapshot das variáveis de ambiente do reenvio (restaura no fim). */
function guardarEnv() {
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

test("reenvio: o padrão é 24h, ligado e em todos os fluxos", () => {
  const env = guardarEnv();
  try {
    delete process.env.MENSAGERIA_REENVIO_DUP_ATIVO;
    delete process.env.MENSAGERIA_REENVIO_DUP_HORAS;
    delete process.env.MENSAGERIA_REENVIO_DUP_TIPOS;
    assert.equal(reenvioAtivo(), true);
    assert.equal(horasReenvio(), 24);
    assert.deepEqual(tiposComReenvio(), ["cliente.enviar", "monitor.encaminhar"]);
    assert.equal(reenvioPermitido("cliente.enviar"), true);
    assert.equal(reenvioPermitido("monitor.encaminhar"), true);
  } finally {
    env.restaurar();
  }
});

test("reenvio: o switch global desliga para todos os tipos", () => {
  const env = guardarEnv();
  try {
    process.env.MENSAGERIA_REENVIO_DUP_ATIVO = "0";
    assert.equal(reenvioAtivo(), false);
    assert.equal(reenvioPermitido("cliente.enviar"), false);
    assert.equal(reenvioPermitido("monitor.encaminhar"), false);
  } finally {
    env.restaurar();
  }
});

test("reenvio: o switch por tipo desliga só o Monitor", () => {
  const env = guardarEnv();
  try {
    process.env.MENSAGERIA_REENVIO_DUP_ATIVO = "1";
    process.env.MENSAGERIA_REENVIO_DUP_TIPOS = "cliente.enviar";
    assert.equal(reenvioPermitido("cliente.enviar"), true);
    assert.equal(reenvioPermitido("monitor.encaminhar"), false);
    process.env.MENSAGERIA_REENVIO_DUP_TIPOS = "*";
    assert.equal(reenvioPermitido("qualquer.tipo"), true);
  } finally {
    env.restaurar();
  }
});

test("reenvio: o momento é o lançamento + N horas (24h do lançamento, não da detecção)", () => {
  const lancamento = "2026-11-12T10:00:00.000Z";
  // detectado 2h depois do lançamento
  const agora = Date.parse("2026-11-12T12:00:00.000Z");
  const m = momentoReenvio(lancamento, { agora });
  assert.equal(m.em, "2026-11-13T10:00:00.000Z", "reenvio 24h depois do lançamento");
  assert.equal(m.ciclos, 0);
});

test("reenvio: lançado ontem às 08:00 e detectado hoje às 10:00 → amanhã às 08:00", () => {
  const lancamento = "2026-11-11T08:00:00.000Z";
  const agora = Date.parse("2026-11-12T10:00:00.000Z");
  const m = momentoReenvio(lancamento, { agora });
  // o ciclo de 24h (12/11 08:00) já passou → rola para o próximo ciclo
  assert.equal(m.em, "2026-11-13T08:00:00.000Z", "reagendado para as 08:00 de amanhã");
  assert.equal(m.ciclos, 1);
  // nunca no passado: um instante depois, o alvo continua no futuro
  const m2 = momentoReenvio(lancamento, { agora: Date.parse("2026-11-12T12:00:00.000Z") });
  assert.equal(m2.em, "2026-11-13T08:00:00.000Z", "rolagem para o próximo ciclo");
  assert.equal(Date.parse(m2.em) > Date.parse("2026-11-12T12:00:00.000Z"), true);
});

test("reenvio: agendar devolve o envelope reagendado (com marcador e sem perder o correlationId)", () => {
  const env = criarEnvelope(
    "cliente.enviar",
    { jid: "5511999999999" },
    { correlationId: "corr-original", chave: "promo-1:5511999999999", timestamp: "2026-11-12T10:00:00.000Z" },
  );
  const agora = Date.parse("2026-11-12T12:00:00.000Z");
  const reagendado = agendarReenvioDuplicado(env, { agora });

  assert.equal(reagendado.proximaTentativaEm, "2026-11-13T10:00:00.000Z");
  assert.equal(reagendado.correlationId, "corr-original", "o correlationId original é preservado");
  assert.equal(reagendado.chave, "promo-1:5511999999999", "a chave é preservada");
  assert.equal(reagendado.tentativas, env.tentativas, "o reagendamento não conta como tentativa");
  assert.ok(reagendado.reenvio, "o envelope ganha o marcador de reenvio");
  assert.equal(reagendado.reenvio!.originalEm, "2026-11-12T10:00:00.000Z");
  assert.equal(reagendado.reenvio!.chave, "promo-1:5511999999999");
  assert.equal(ehReenvioAgendado(reagendado), true, "o consumidor reconhece o reenvio");
  assert.equal(ehReenvioAgendado(env), false, "o envelope original não é reenvio");
  // o envelope continua válido no schema zod (campo novo é opcional)
  assert.doesNotThrow(() => validarEnvelope(reagendado));
});

test("reenvio: a reserva é limpa (o item volta para a fila elegível no horário)", () => {
  const env = criarEnvelope("cliente.enviar", { jid: "1" }, {
    correlationId: "corr-1",
    chave: "k",
    timestamp: "2026-11-12T10:00:00.000Z",
  });
  const reservado = { ...env, emAndamento: true, reservadoEm: "2026-11-12T12:00:00.000Z" };
  const reagendado = agendarReenvioDuplicado(reservado, { agora: Date.parse("2026-11-12T12:00:00.000Z") });
  assert.equal(reagendado.emAndamento, undefined);
  assert.equal(reagendado.reservadoEm, undefined);
});
