# 03 — Arquitetura e UML — autoMensagemWhats

> v0.1 | 2026-10-12 | Stack: Node 20 ESM + TS + SQLite + Evolution API + Provider ML + EngAI Gateway

## 1. Decisões (resumo, detalhe em `docs/04-ADRs/`)
- ADR-001: Evolution no MVP + interface para Cloud (híbrido).
- ADR-002: IA só via Gateway com approval, nunca direto.
- ADR-003: Afilimax/Garimpei self-host + fallback manual (cookie instável).

## 2. Casos de Uso (Mermaid)
```mermaid
flowchart LR
  OP([Operador Afiliado]) --> UC1(Cadastrar oferta por URL)
  OP --> UC2(Revisar e aprovar copy)
  OP --> UC3(Enviar para grupo piloto)
  ADM([Admin Canal]) --> UC2
  ADM --> UC4(Agendar lote)
  UC1 --> UC5((Enriquecer dados ML))
  UC5 --> UC6((Gerar copy Template ou IA))
  UC6 --> UC7(Preview WhatsApp)
  UC7 --> UC2
  UC2 --> UC3
  SYS([Job Healthcheck]) --> UC8(Validar cookie e sessao)
```

Consistência: todo RF tem UC (RF-001→UC1, RF-002→UC5, RF-004/005→UC6, RF-007→UC7, RF-008→UC2, RF-009/010→UC3, RF-012→UC8).

## 3. Classes / ER (Mermaid)
```mermaid
classDiagram
  class Oferta {
    +string id
    +string urlOriginal
    +string urlCanon
    +string titulo
    +string imagemUrl
    +float precoDe
    +float precoPix
    +float precoParc
    +int parcelas
    +string cupom
    +string linkAfiliado
    +string status
    +string mensagemFormatada
  }
  class LoteEnvio {
    +string id
    +string grupoId
    +datetime agendadoPara
    +string status
    +aprovar()
  }
  class DispatchProvider {
    <<interface>>
    +send()
  }
  class EvolutionProvider {
    +instance
    +send()
  }
  class CloudProvider {
    +wabaId
    +send()
  }
  class AIGateway {
    +generate()
    +route()
  }
  Oferta --> LoteEnvio : compoe
  LoteEnvio --> DispatchProvider : usa
  DispatchProvider <|.. EvolutionProvider
  DispatchProvider <|.. CloudProvider
  Oferta --> AIGateway : copy opcional
```

SQLite tabelas: `ofertas`, `lotes`, `envios(messageId,status)`, `traces(modelo,tokens,custo,ms)`.

## 4. Sequência — fluxo principal (Mermaid)
```mermaid
sequenceDiagram
  actor OP as Operador
  participant CLI as CLI
  participant ENR as Enrich ML
  participant AI as AIGateway
  participant FMT as Formatter
  participant APR as Approval
  participant EVO as Evolution API
  OP->>CLI: cadastra meli.la URL
  CLI->>ENR: extract(url)
  ENR-->>CLI: titulo precos imagem link
  CLI->>AI: generate(headline, mode)
  AI-->>CLI: 5 variacoes + trace
  CLI->>FMT: aplica RN-001 + emojis
  FMT-->>CLI: mensagem WhatsApp
  CLI->>APR: solicita aprovacao
  OP->>APR: aprova lote
  APR->>EVO: sendText+Image(grupo, caption)
  EVO-->>CLI: messageId status
```

## 5. Componentes / Deploy (texto + Mermaid)
```mermaid
graph TD
  CLI[CLI Node TS] --> ENR[ML Provider Afilimax Garimpei]
  CLI --> AIG[EngAI Gateway Router Cache Guardrail]
  AIG --> LLM[(LLM cheap smart)]
  CLI --> FMT[Formatter WhatsApp]
  CLI --> DB[(SQLite)]
  CLI --> EVO[Evolution API Docker]
  EVO --> WA[WhatsApp Grupo]
  CLI --> CLOUD[Cloud API futuro]
  CLOUD --> WA
```
Deploy MVP: 1 VPS Docker (app + Evolution + SQLite volume), `.env` para segredos, 1 IP BR dedicado por nº. Futuro: Cloud API sem mudar CLI (troca Provider).

## 6. Estrutura de pastas proposta
```
src/
  cli.ts
  oferta/service.ts schema.ts
  ml/provider.ts afilimax.ts garimpei.ts fallback.ts
  ai/gateway.ts tools/ prompts/
  wa/formatter.ts dispatch.ts evolution.ts cloud.ts
  store/sqlite.ts jobs/health.ts obs/stats.ts
docs/ image/ .env.example docker-compose.yml
```

## 7. Validação de consistência
- [x] Toda entidade tem dono (Oferta→OP, Lote→ADM, Trace→SISTEMA).
- [x] Todo RF rastreável (§7 SRS).
- [x] Nenhum envio sem approval (RN-006).
- [x] Números nunca mutados pela IA (RN-005 + Zod).
