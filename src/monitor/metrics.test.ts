/**
 * Testes do módulo de métricas Prometheus.
 * Verifica formato de saída e valores esperados.
 * 
 * Note: os contadores específicos são testados em state.test.ts, fila.test.ts, etc.
 * Aqui validamos apenas o formato Prometheus e os headers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("exportarMetricas retorna formato Prometheus válido", async () => {
  const { exportarMetricas } = await import("./metrics.js");
  const output = exportarMetricas();

  // Deve conter HELP e TYPE
  assert.ok(output.includes("# HELP"), "deve conter HELP");
  assert.ok(output.includes("# TYPE"), "deve conter TYPE");
  assert.ok(output.includes("alcance_up"), "deve conter métrica de up");
});

test("exportarMetricas inclui header de documentação", async () => {
  const { exportarMetricas } = await import("./metrics.js");
  const output = exportarMetricas();

  // Deve começar com o header de documentação
  assert.ok(output.startsWith("# HELP alcance_up"), "header de documentação presente");
  // Deve conter a descrição do projeto
  assert.ok(output.includes("Alcance Promo Radar Telemetry"), "descrição do projeto");
});

test("metricsHealth indica sistema online com alcance_up=1", async () => {
  const { exportarMetricas } = await import("./metrics.js");
  const output = exportarMetricas();

  assert.ok(output.includes("alcance_up 1"), "sistema up");
  assert.ok(output.includes("# HELP alcance_up 1 se o serviço está saudável"), "descrição health");
  assert.ok(output.includes("# TYPE alcance_up gauge"), "tipo gauge");
});

test("resetarCacheMetricas limpa o cache", async () => {
  const { exportarMetricas, resetarCacheMetricas } = await import("./metrics.js");

  const output1 = exportarMetricas();
  resetarCacheMetricas();
  const output2 = exportarMetricas();

  assert.ok(output1.includes("alcance_up"), "primeira exportação tem conteúdo");
  assert.ok(output2.includes("alcance_up"), "segunda exportação tem conteúdo");
});

test("exportarMetricas cacheia por 5 segundos", async () => {
  const { exportarMetricas, resetarCacheMetricas } = await import("./metrics.js");

  const output1 = exportarMetricas();
  const output2 = exportarMetricas();

  // Mesmo conteúdo (cache funcionando)
  assert.equal(output1, output2, "cache deve retornar mesma saída");

  // Reset força nova leitura
  resetarCacheMetricas();
  const output3 = exportarMetricas();
  // A idade da fila é calculada no scrape (sobe 1ms a cada leitura): ela é
  // comparada sem o valor volátil, senão o teste vira uma corrida.
  const semIdade = (s: string) =>
    s
      .split("\n")
      .filter((l) => !l.startsWith("alcance_msg_idade_fila_ms{"))
      .join("\n");
  assert.equal(semIdade(output3), semIdade(output1), "mesmo conteúdo após reset");
});

test("metricsJanela indica estado com alcance_janela_aberta", async () => {
  const { exportarMetricas } = await import("./metrics.js");
  const output = exportarMetricas();

  // Deve conter a métrica da janela
  assert.ok(output.includes("alcance_janela_aberta"), "métrica da janela presente");
  assert.ok(output.includes("# TYPE alcance_janela_aberta gauge"), "tipo gauge");
  // O valor deve ser 0 ou 1
  assert.ok(
    output.includes("alcance_janela_aberta 0") || output.includes("alcance_janela_aberta 1"),
    "valor 0 ou 1"
  );
});

test("exportarMetricas tem múltiplas seções separadas por linha vazia", async () => {
  const { exportarMetricas } = await import("./metrics.js");
  const output = exportarMetricas();

  // Verifica estrutura: health, monitor, fila, instancias, janela, disparos
  const sections = output.split("\n\n");
  assert.ok(sections.length >= 5, "deve ter múltiplas seções");
  
  // Verifica headers específicos
  assert.ok(output.includes("# HELP alcance_up"), "seção health");
  assert.ok(output.includes("# HELP alcance_monitor_recebidas_total"), "seção monitor");
  assert.ok(output.includes("# HELP alcance_fila_tamanho"), "seção fila");
  assert.ok(output.includes("# HELP alcance_instancias_ativas_total"), "seção instancias");
  assert.ok(output.includes("# HELP alcance_disparos_total"), "seção disparos");
});

test("formato das métricas segue padrão Prometheus", async () => {
  const { exportarMetricas } = await import("./metrics.js");
  const output = exportarMetricas();

  // Cada métrica deve ter: HELP, TYPE, valor (em ordem)
  const lines = output.split("\n");
  
  // Encontrar primeira métrica completa
  let foundCompleteMetric = false;
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i].startsWith("# HELP") && 
        lines[i+1].startsWith("# TYPE") && 
        !lines[i+2].startsWith("#")) {
      foundCompleteMetric = true;
      break;
    }
  }
  assert.ok(foundCompleteMetric, "deve ter formato HELP, TYPE, valor");
});
// ---------- issue #52: métricas da Mensageria ----------

/** Prepara um data dir temporário com fila e DLQ de clientes. */
async function prepararMensageria(pendentes: number, dlq: number) {
  const dir = mkdtempSync(join(tmpdir(), "alcance-metrics-"));
  process.env.ALCANCE_DATA_DIR = dir;
  mkdirSync(join(dir, "messaging"), { recursive: true });
  const envelopes = Array.from({ length: pendentes }, (_, i) => ({
    id: `e${i}`,
    tipo: "cliente.enviar",
    versao: 1,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    correlationId: "abc-123",
    tentativas: 0,
    payload: { jid: `551199999999${i}@s.whatsapp.net` },
  }));
  writeFileSync(join(dir, "messaging", "cliente.enviar.json"), JSON.stringify(envelopes, null, 2));
  const itensDlq = Array.from({ length: dlq }, (_, i) => ({
    id: `d${i}`,
    tipo: "cliente.enviar",
    envelope: envelopes[0],
    motivo: "erro não transitório",
    ultimoErro: "Connection Closed",
    tentativas: 4,
    ultimaTentativaEm: new Date().toISOString(),
    origem: "disp-1",
  }));
  writeFileSync(join(dir, "messaging", "dlq-cliente.enviar.json"), JSON.stringify(itensDlq, null, 2));
  return dir;
}

test("métricas: a fila aparece em alcance_msg_fila_tamanho", async () => {
  const dir = await prepararMensageria(3, 0);
  try {
    const { exportarMetricas, resetarCacheMetricas } = await import("./metrics.js");
    resetarCacheMetricas();
    const output = exportarMetricas();
    assert.ok(output.includes("# TYPE alcance_msg_fila_tamanho gauge"), "tipo gauge");
    assert.ok(
      output.includes('alcance_msg_fila_tamanho{tipo="cliente.enviar"} 3'),
      "3 mensagens pendentes na fila de clientes",
    );
    assert.ok(output.includes("alcance_msg_idade_fila_ms"), "idade da fila exposta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("métricas: a DLQ aparece em alcance_msg_dlq_tamanho", async () => {
  const dir = await prepararMensageria(1, 2);
  try {
    const { exportarMetricas, resetarCacheMetricas } = await import("./metrics.js");
    resetarCacheMetricas();
    const output = exportarMetricas();
    assert.ok(output.includes("# TYPE alcance_msg_dlq_tamanho gauge"), "tipo gauge");
    assert.ok(
      output.includes('alcance_msg_dlq_tamanho{tipo="cliente.enviar"} 2'),
      "2 itens na DLQ de clientes",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("métricas: duplicatas e latência são contabilizadas", async () => {
  const dir = await prepararMensageria(0, 0);
  try {
    const contadores = await import("../messaging/contadores.js");
    contadores.zerarContadores();
    contadores.incrementar("alcance_msg_duplicadas_total", { tipo: "cliente.enviar" });
    contadores.observarLatencia("alcance_msg_latencia_envio_ms", { tipo: "cliente.enviar" }, 120);
    const { exportarMetricas, resetarCacheMetricas } = await import("./metrics.js");
    resetarCacheMetricas();
    const output = exportarMetricas();
    assert.ok(
      output.includes('alcance_msg_duplicadas_total{tipo="cliente.enviar"} 1'),
      "duplicatas contabilizadas",
    );
    assert.ok(output.includes("# TYPE alcance_msg_latencia_envio_ms histogram"), "histograma exposto");
    assert.ok(output.includes("alcance_msg_latencia_envio_ms_count"), "contagem do histograma");
    assert.ok(output.includes('alcance_msg_latencia_envio_ms_bucket{tipo="cliente.enviar",le="+Inf"}'), "bucket +Inf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("métricas: o formato Prometheus continua válido com a seção de mensageria", async () => {
  const dir = await prepararMensageria(1, 1);
  try {
    const { exportarMetricas, resetarCacheMetricas } = await import("./metrics.js");
    resetarCacheMetricas();
    const output = exportarMetricas();
    const linhas = output.split("\n");
    for (let i = 0; i < linhas.length; i++) {
      if (linhas[i].startsWith("# HELP")) {
        assert.ok(linhas[i + 1].startsWith("# TYPE"), `HELP sem TYPE em: ${linhas[i]}`);
      }
    }
    assert.ok(output.includes("alcance_fila_tamanho"), "a métrica antiga continua exposta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
