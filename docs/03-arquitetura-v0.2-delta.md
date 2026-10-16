# 03 — Arquitetura e UML [v0.2 HUNTER]

> v0.2 | Scheduler + Hunter + Scorer. Formatter RN-001 e providers inalterados.

## 2. Casos de Uso v0.2
```mermaid
flowchart LR
  OP([Operador]) --> UC10(Escolher categoria e filtros)
  UC10 --> UC11((Varredura agendada))
  UC11 --> UC12((Rankear oportunidades))
  UC12 --> UC13(Gerar msg automatica)
  UC13 --> UC14{Modo}
  UC14 -->|REVISAO| UC2(Revisar e aprovar)
  UC14 -->|AUTO| UC3(Enviar sozinho)
  UC2 --> UC3
  UC3 --> GRUPO[(Grupo WhatsApp)]
  SYS([Scheduler]) --> UC11
```

## 4. Sequência hunter (novo fluxo principal)
```mermaid
sequenceDiagram
  actor OP as Dono
  participant SCH as Scheduler cron 2h
  participant HUN as Hunter ML Top50
  participant SCO as Scorer
  participant ENR as Enrich link afiliado
  participant AI as AIGateway copy
  participant FMT as Formatter RN-001
  participant DIS as Dispatch AUTO REVISAO
  OP->>SCH: configura Relogios desc30 teto500 AUTO_ON
  SCH->>HUN: search categoria + filtros
  HUN-->>SCH: 50 candidatos
  SCH->>SCO: score + motivo
  SCO-->>SCH: Top3 score 92 84 78
  SCH->>ENR: convert-links Top3
  ENR-->>SCH: meli.la links
  SCH->>AI: headline variacao
  AI-->>SCH: copy + trace
  SCH->>FMT: aplica template
  FMT-->>DIS: msg pronta
  alt AUTO e dentro janela e limite
    DIS->>DIS: envia Evolution + log motivo
  else REVISAO
    DIS->>OP: pede approval
    OP->>DIS: aprova
    DIS->>DIS: envia
  end
```

## Classes delta
```mermaid
classDiagram
  class Categoria {
    +string id
    +string nome
    +int descontoMin
    +float teto
    +bool soComCupom
    +string modo
  }
  class Oportunidade {
    +string mlbId
    +float score
    +string motivo
    +bool duplicada
  }
  class Hunter {
    +search()
  }
  class Scorer {
    +score()
  }
  Categoria --> Oportunidade : gera
  Hunter --> Oportunidade : coleta
  Scorer --> Oportunidade : ranqueia
```

Tabelas novas: `categorias`, `coletas(mlbId,preco,data)`, `oportunidades(score,motivo)`, `envios(hash,mlbId,data)` com índice anti-duplicidade 7d.

## ADR-004 (resumo)
Hunter self-host com cache 2h + histórico local; score explicável versionado; AUTO com kill-switch e default REVISÃO. Ver `docs/04-ADRs/ADR-004-hunter.md`.
