# SRS - Sistema de Telemetria para Alcance Promo Radar

## 1. Introdução

### 1.1 Propósito
Este documento especifica o sistema de telemetria e monitoramento para o Alcance Promo Radar, uma aplicação Node.js/TypeScript que gerencia campanhas de monitoramento e envio de ofertas via WhatsApp Business.

### 1.2 Escopo
Implementar coleta de métricas com **Prometheus** e visualização com **Grafana**, permitindo monitoramento em tempo real das operações do sistema via API.

### 1.3 Definições
- **Prometheus**: Sistema de coleta de métricas de código aberto
- **Grafana**: Plataforma de visualização e dashboards
- **Exporter**: Endpoint HTTP que expõe métricas no formato Prometheus
- **Métrica**: Valor mensurável com label (nome, valor, timestamp)

### 1.4 Referências
- [Prometheus Format](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [Grafana Dashboard JSON](https://grafana.com/docs/grafana/latest/dashboards/json-fields/)

---

## 2. Descrição Geral

### 2.1 Visão do Sistema
```
┌─────────────┐     scrape     ┌──────────────┐     visualize    ┌─────────┐
│  Manager    │ ────────────▶ │  Endpoint    │ ────────────▶ │ Grafana │
│  (app)      │    /metrics   │  /metrics    │   dashboards   │         │
└─────────────┘               └──────────────┘                └─────────┘
      │                             │
      │                             │
      └────────── read state ───────┘
```

### 2.2 Stakeholders
- **Operador**: Visualiza dashboards para acompanhar saúde do sistema
- **Desenvolvedor**: Analisa métricas para debugging e otimização

### 2.3 Restrições
- Sem dependências externas (sem agente de telemetria)
- Métricas coletadas do estado já persistido em `data/monitor-estado.json`
- Docker-native: funciona em ambiente composto com Prometheus
- Não interfere no throughput do envio (leitura não bloqueante)

---

## 3. Requisitos Funcionais

### RF-001: Expor Endpoint de Métricas
**Título:** Endpoint HTTP `/metrics` no formato Prometheus

**Descrição:** O sistema deve expor um endpoint HTTP GET na porta 8091 que retorna métricas no formatoTexto Prometheus, compatível com scraping automático.

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Endpoint /metrics retorna métricas em formato Prometheus
  Dado que o Manager está rodando
  Quando faço GET para http://localhost:8091/metrics
  Então recebo HTTP 200
  E o conteúdo tem "Content-Type: text/plain; version=0.0.4"
  E o conteúdo contém métricas no formato Prometheus
```

**Prioridade:** Crítico (Must-have)

---

### RF-002: Métrica de Contadores do Monitor
**Título:** Contadores de eventos do monitor (encaminhadas, duplicadas, erros)

**Descrição:** Expor contadores acumulativos dos eventos do monitor, derivados de `data/monitor-estado.json`.

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Métrica de encaminhadas aumenta
  DADO que eventosMonitor.totais.encaminhadas = 10
  QUANDO GET /metrics
  ENTÃO resposta contém "alcance_monitor_encaminhadas_total 10"
```

**Métricas:**
- `alcance_monitor_recebidas_total` - Mensagem recebida
- `alcance_monitor_encaminhadas_total` - Mensagem encaminhada
- `alcance_monitor_duplicadas_total` - Mensagem duplicada
- `alcance_monitor_revisao_total` - Mensagem em revisão
- `alcance_monitor_erros_total` - Mensagem com erro
- `alcance_monitor_enfileiradas_total` - Mensagem na fila

**Prioridade:** Crítico (Must-have)

---

### RF-003: Métrica de Fila
**Título:** Estado da fila de processamento

**Descrição:** Expor métricas sobre o tamanho e estado da fila.

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Métrica de tamanho da fila
  DADO que tamanhoFila() = 5
  QUANDO GET /metrics
  ENTÃO resposta contém "alcance_fila_tamanho 5"
```

**Métricas:**
- `alcance_fila_tamanho` - Número de itens na fila
- `alcance_fila_em_andamento` - Número de itens em processamento

**Prioridade:** Alto (Should-have)

---

### RF-004: Métrica de Instâncias WhatsApp
**Título:** Estado das instâncias WhatsApp

**Descrição:** Expor métricas sobre o estado das instâncias WhatsApp (abertas, fechadas, em janela).

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Métrica de instâncias
  DADO que 2 instâncias estão abertas e 1 fechada
  QUANDO GET /metrics
  ENTÃO resposta contém labels corretos:
    alcance_instancia_estado{estado="aberta", nome="whatsapp1"} 1
    alcance_instancia_estado{estado="fechada", nome="whatsapp2"} 1
```

**Métricas:**
- `alcance_instancia_estado` - Estado de cada instância (aberta/fechada/pausada)
- `alcance_instancia_em_janela` - Instância dentro da janela horária (0/1)

**Prioridade:** Alto (Should-have)

---

### RF-005: Métrica de Janela Comercial
**Título:** Estado da janela comercial

**Descrição:** Expor se a janela comercial (08:00-23:00) está aberta ou fechada.

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Janela comercial aberta às 14h
  DADO que são 14:00 em São Paulo
  QUANDO GET /metrics
  ENTÃO resposta contém "alcance_janela_aberta 1"
```

**Métricas:**
- `alcance_janela_aberta` - 1 se dentro da janela, 0 se fora

**Prioridade:** Médio (Could-have)

---

### RF-006: Métrica de Disparos
**Título:** Contadores de campanhas (disparos)

**Descrição:** Expor métricas sobre campanhas criadas, enviadas e seus status.

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Métrica de disparos concluídos
  DADO que 3 disparos estão CONCLUIDO
  QUANDO GET /metrics
  ENTÃO resposta contém "alcance_disparos_concluidos_total 3"
```

**Métricas:**
- `alcance_disparos_total` - Total de campanhas
- `alcance_disparos_pendentes_total` - Campanhas pendentes
- `alcance_disparos_enviando_total` - Campanhas em andamento
- `alcance_disparos_concluidos_total` - Campanhas concluídas
- `alcance_disparos_parciais_total` - Campanhas parciais (alguns falharam)
- `alcance_disparos_erros_total` - Campanhas com erro
- `alcance_disparos_cancelados_total` - Campanhas canceladas
- `alcance_disparos_entregues_total` - Total de mensagens entregues
- `alcance_disparos_falhas_total` - Total de falhas

**Prioridade:** Médio (Could-have)

---

### RF-007: Métrica de HTTP Requests
**Título:** Contagem de requisições HTTP

**Descrição:** Expor contadores de requisições HTTP por endpoint e status.

**Critério de Aceitação (Gherkin):**
```gherkin
Cenário: Métrica de requisições
  DADO que houve 100 chamadas ao /api/disparos
  QUANDO GET /metrics
  ENTÃO resposta contém "alcance_http_requests_total{endpoint="/api/disparos",status="200"} 100"
```

**Métricas:**
- `alcance_http_requests_total` - Contador de requisições (labels: endpoint, status, metodo)

**Prioridade:** Médio (Could-have)

---

## 4. Requisitos Não-Funcionais

### RNF-001: Formato de Métricas
As métricas seguem o **padrão Prometheus OpenMetrics**:
- Texto plano, UTF-8
- Linhas começam com `#` para comentários/types HELP/TYPE
- Métricas no formato: `nome{labels} valor`

### RNF-02: Desempenho
- Endpoint `/metrics` responde em < 100ms
- Leitura do estado não bloqueia o evento loop (usar readFileAsync)
- Cache de métricas por até 5 segundos para evitar leituras repetidas

### RNF-03: Segurança
- Endpoint `/metrics` é público (não requer autenticação)
- Não expõe dados sensíveis (tokens, senhas, informações pessoais)
- Métricas são agregadas, não detalhadas

### RNF-04: Observabilidade
- Todas as métricas têm HELP e TYPE apropriados
- Labels padronizadas (snake_case, valores limpos)
- Métricas acumulativas (counters) e gauges conforme apropriado

---

## 5. Regras de Negócio

### RN-001: Derivar Contadores de Eventos
Os contadores do monitor (`eventosMonitor.totais`) são derivados dos eventos armazenados e persistidos periodicamente. O exporter deve ler o estado atual, não o histórico.

### RN-002: Estados de Instância
Estados válidos de instância: `aberta`, `fechada` (close), `desconectada`. A métrica deve usar o estado mais recente.

### RN-003: Janela Comercial
A janela é definida como 08:00-23:00 no fuso America/Sao_Paulo. Fora dessa janela, a métrica deve ser 0.

---

## 6. Matriz de Rastreabilidade

| RF | Teste | Arquivo |
|----|-------|---------|
| RF-001 | test(metrics): /metrics returns Prometheus format | src/monitor/metrics.test.ts |
| RF-002 | test(metrics): monitor counters | src/monitor/metrics.test.ts |
| RF-003 | test(metrics): fila metrics | src/monitor/metrics.test.ts |
| RF-004 | test(metrics): instancia metrics | src/monitor/metrics.test.ts |
| RF-005 | test(metrics): janela metric | src/monitor/metrics.test.ts |
| RF-006 | test(metrics): disparos metrics | src/monitor/metrics.test.ts |
| RF-007 | test(metrics): http requests | src/monitor/metrics.test.ts |

---

## 7. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Alta frequência de scrape sobrecarrega I/O | Médio | Alto | Cache de 5s, leitura assíncrona |
| Formato Prometheus incompatível com versões | Baixo | Médio | Usar biblioteca pino-metrics ou parser próprio compatível |
| Dashboard Grafana quebrado após upgrade | Baixo | Médio | Versionar JSON do dashboard |

---

## 8. Glossário

- **Telemetry**: Coleta automática de dados de comportamento e desempenho
- **Exporter**: Componente que expõe métricas em formato que o scrapers entende
- **Gauge**: Métrica que pode subir e descer (ex: tamanho da fila)
- **Counter**: Métrica acumulativa só aumenta (ex: total de mensagens enviadas)
- **Histogram**: Métrica de distribuição (não usado neste projeto)
- **Summary**: Métrica de quantile (não usado neste projeto)