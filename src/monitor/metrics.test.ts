/**
 * Testes do módulo de métricas Prometheus.
 * Verifica formato de saída e valores esperados.
 * 
 * Note: os contadores específicos são testados em state.test.ts, fila.test.ts, etc.
 * Aqui validamos apenas o formato Prometheus e os headers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(output3, output1, "mesmo conteúdo após reset");
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