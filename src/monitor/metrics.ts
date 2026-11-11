/**
 * Métricas Prometheus Exporter
 * 
 * Exporta endpoints e contadores no formato Prometheus para scraping pelo Prometheus.
 * Usado para visualização no Grafana.
 * 
 * Referência: https://prometheus.io/docs/instrumenting/exposition_formats/
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { resumo as resumoMonitor, eventos } from "./state.js";
import { tamanhoFila } from "./fila.js";
import { listarInstancias } from "../wa/rotacao.js";
import { resumoDisparos } from "../clientes/disparos.js";
import { estadoJanela } from "./janela.js";

/** Cache de métricas para evitar leituras repetidas (5s TTL) */
let metricsCache: string | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5000;

/**
 * Formata um valor ou label para o formato Prometheus escapando caracteres problemáticos.
 */
function escapeLabel(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Formata label para Prometheus (chave="valor").
 */
function formatLabel(key: string, value: string): string {
  return `${escapeLabel(key)}="${escapeLabel(value)}"`;
}

/**
 * Cabeçalho HELP para métrica.
 */
function help(name: string, description: string): string {
  return `# HELP ${name} ${description}`;
}

/**
 * Tipo da métrica (counter, gauge, histogram, summary).
 */
function type(name: string, typ: "counter" | "gauge"): string {
  return `# TYPE ${name} ${typ}`;
}

/**
 * Métricas do monitor (encaminhadas, duplicadas, erros, etc).
 * Derivados do estado salvo em data/monitor-estado.json
 */
function metricsMonitor(): string {
  const resumo = resumoMonitor();
  const lines: string[] = [];

  const metrics: Array<[string, number, string]> = [
    ["alcance_monitor_recebidas_total", resumo.recebidas, "Mensagens recebidas"],
    ["alcance_monitor_encaminhadas_total", resumo.encaminhadas, "Mensagens encaminhadas"],
    ["alcance_monitor_duplicadas_total", resumo.duplicadas, "Mensagens duplicadas"],
    ["alcance_monitor_revisao_total", resumo.revisao, "Mensagens em revisão"],
    ["alcance_monitor_erros_total", resumo.erros, "Mensagens com erro"],
    ["alcance_monitor_enfileiradas_total", resumo.enfileiradas, "Mensagens na fila"],
  ];

  for (const [name, value, desc] of metrics) {
    lines.push(help(name, desc));
    lines.push(type(name, "counter"));
    lines.push(`${name} ${value}`);
  }

  return lines.join("\n");
}

/**
 * Métricas da fila de processamento.
 */
function metricsFila(): string {
  const tamanho = tamanhoFila();
  const eventosAtivos = eventos(1); // não expõe eventos detalhados
  const emAndamento = eventosAtivos.length > 0 ? 1 : 0;

  const lines: string[] = [];

  lines.push(help("alcance_fila_tamanho", "Número de itens na fila de processamento"));
  lines.push(type("alcance_fila_tamanho", "gauge"));
  lines.push(`alcance_fila_tamanho ${tamanho}`);

  lines.push(help("alcance_fila_em_andamento", "1 se há item em processamento, 0 caso contrário"));
  lines.push(type("alcance_fila_em_andamento", "gauge"));
  lines.push(`alcance_fila_em_andamento ${emAndamento}`);

  return lines.join("\n");
}

/**
 * Métricas de instâncias WhatsApp.
 * Observação: estados são recuperados via API Evolution com TTL de 45s.
 * Métricas simplificadas para evitar chamadas síncronas durante o scrape.
 */
function metricsInstancias(): string {
  const instancias = listarInstancias();

  const lines: string[] = [];

  // Estado geral
  lines.push(help("alcance_instancias_ativas_total", "Total de instâncias ativas cadastradas"));
  lines.push(type("alcance_instancias_ativas_total", "gauge"));
  const ativas = instancias.filter((i: any) => i.ativo).length;
  lines.push(`alcance_instancias_ativas_total ${ativas}`);

  lines.push(help("alcance_instancias_cadastradas_total", "Total de instâncias cadastradas"));
  lines.push(type("alcance_instancias_cadastradas_total", "gauge"));
  lines.push(`alcance_instancias_cadastradas_total ${instancias.length}`);

  // Métricas por instância (sem estado de conexão, pois requer chamada HTTP)
  for (const inst of instancias) {
    const nome = (inst.nome ?? inst.instancia) || "unknown";
    const instanciaId = inst.instancia || "unknown";
    const ativo = inst.ativo ? 1 : 0;
    const peso = inst.peso ?? 1;
    const enviadas = inst.enviadas ?? 0;

    lines.push(help("alcance_instancia_ativa", "1 se instância está ativa, 0 se inativa"));
    lines.push(type("alcance_instancia_ativa", "gauge"));
    lines.push(`alcance_instancia_ativa{instancia="${escapeLabel(instanciaId)}",nome="${escapeLabel(nome)}"} ${ativo}`);

    lines.push(help("alcance_instancia_peso", "Peso da instância (1..10)"));
    lines.push(type("alcance_instancia_peso", "gauge"));
    lines.push(`alcance_instancia_peso{instancia="${escapeLabel(instanciaId)}",nome="${escapeLabel(nome)}"} ${peso}`);

    lines.push(help("alcance_instancia_enviadas_total", "Total de mensagens enviadas pela instância"));
    lines.push(type("alcance_instancia_enviadas_total", "counter"));
    lines.push(`alcance_instancia_enviadas_total{instancia="${escapeLabel(instanciaId)}",nome="${escapeLabel(nome)}"} ${enviadas}`);
  }

  return lines.join("\n");
}

/**
 * Métricas da janela comercial (08:00-23:00).
 */
function metricsJanela(): string {
  const agora = new Date();
  const jaWindow = estadoJanela(agora);

  const lines: string[] = [];

  lines.push(help("alcance_janela_aberta", "1 se dentro da janela comercial (08:00-23:00), 0 se fora"));
  lines.push(type("alcance_janela_aberta", "gauge"));
  lines.push(`alcance_janela_aberta ${jaWindow.aberta ? 1 : 0}`);

  // Próximo reabertura/fechamento (jaWindow.reabreAs já é string "HH:MM")
  if (!jaWindow.aberta && jaWindow.reabreAs) {
    lines.push(`# Próximo reabertura: ${jaWindow.reabreAs}`);
  }

  return lines.join("\n");
}

/**
 * Métricas de disparos (campanhas de clientes).
 */
function metricsDisparos(): string {
  const resumo = resumoDisparos();

  const lines: string[] = [];

  const metrics: Array<[string, number, string]> = [
    ["alcance_disparos_total", resumo.total, "Total de campanhas criadas"],
    ["alcance_disparos_pendentes_total", resumo.pendentes, "Campanhas pendentes"],
    ["alcance_disparos_enviando_total", resumo.porStatus.ENVIANDO, "Campanhas em andamento"],
    ["alcance_disparos_concluidos_total", resumo.porStatus.CONCLUIDO, "Campanhas concluídas com sucesso"],
    ["alcance_disparos_parciais_total", resumo.porStatus.PARCIAL, "Campanhas parciais (alguns falharam)"],
    ["alcance_disparos_erros_total", resumo.porStatus.ERRO, "Campanhas com erro"],
    ["alcance_disparos_cancelados_total", resumo.porStatus.CANCELADO, "Campanhas canceladas"],
  ];

  for (const [name, value, desc] of metrics) {
    lines.push(help(name, desc));
    lines.push(type(name, "counter"));
    lines.push(`${name} ${value}`);
  }

  // Métricas detalhadas
  lines.push(help("alcance_disparos_entregues_total", "Total de mensagens entregues (soma de enviados)"));
  lines.push(type("alcance_disparos_entregues_total", "counter"));
  lines.push(`alcance_disparos_entregues_total ${resumo.enviados}`);

  lines.push(help("alcance_disparos_falhas_total", "Total de falhas (soma de falhas)"));
  lines.push(type("alcance_disparos_falhas_total", "counter"));
  lines.push(`alcance_disparos_falhas_total ${resumo.falhas}`);

  return lines.join("\n");
}

/**
 * Métricas de saúde do sistema.
 */
function metricsHealth(): string {
  const lines: string[] = [];

  // Health check básico
  lines.push(help("alcance_up", "1 se o serviço está saudável, 0 se com problemas"));
  lines.push(type("alcance_up", "gauge"));
  lines.push("alcance_up 1");

  return lines.join("\n");
}

/**
 * Exporta todas as métricas no formato Prometheus.
 * Usa cache por 5 segundos para evitar leituras repetidas do disco.
 */
export function exportarMetricas(): string {
  const agora = Date.now();

  // Retorna cache se ainda válido
  if (metricsCache && agora - cacheTime < CACHE_TTL_MS) {
    return metricsCache;
  }

  const seccoes = [
    "# HELP alcance_up Sistema de monitoramento de ofertas via WhatsApp",
    "# TYPE alcance_up gauge",
    "# Abril 2025 - Alcance Promo Radar Telemetry",
    "",
    metricsHealth(),
    "",
    metricsMonitor(),
    "",
    metricsFila(),
    "",
    metricsInstancias(),
    "",
    metricsJanela(),
    "",
    metricsDisparos(),
  ];

  metricsCache = seccoes.join("\n") + "\n";
  cacheTime = agora;
  return metricsCache;
}

/**
 * Reseta o cache (útil para testes).
 */
export function resetarCacheMetricas(): void {
  metricsCache = null;
  cacheTime = 0;
}