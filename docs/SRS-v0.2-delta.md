# SRS — autoMensagemWhats [v0.2 HUNTER AUTÔNOMO]

> Versão 0.2 | 2026-10-12 | Stack: Node 20 ESM + TS + SQLite + Scheduler + Hunter ML + Scorer + Evolution + EngAI Gateway
> Entrada agora é CATEGORIA, não URL. Saída continua idêntica à imagem base.

## 2.1 Perspectiva v0.2
`Scheduler → Hunter(Search ML) → Scorer → Enrich(link afiliado) → Copy(Template/IA) → Format(RN-001) → Dispatch(AUTO/REVISÃO) → Observe`. Imagem `Screenshot_...WhatsApp.jpg` = padrão de saída.

## 3. Requisitos funcionais (mantidos v0.1 + novos)

Mantidos: RF-001–RF-014 (URL manual vira fallback; formatter RN-001 intacto).

### RF-015 — Escolher categoria + filtros (Must, novo)
**Ator:** OP. Filtros: `categoria, termos, descontoMin (default 30%), tetoReais, sóComCupom?, avaliacaoMin, vendidosMin`.
```gherkin
Dado que sou OP
Quando salvo categoria "Relogios" com descontoMin 30 e teto 500
Então o hunter usa esses filtros na próxima varredura
```

### RF-016 — Caçar oportunidades na categoria (Must)
Varrer Top 50 da busca ML, extrair `MLB-ID, título, imagem, precoDe, precoAtual, cupom?, vendidos, avaliação`, respeitando cache 2h + backoff.
```gherkin
Dado categoria ativa
Quando roda a varredura
Então retorna até 50 candidatos em <90s ou erro RATE_LIMIT com retry agendado
```

### RF-017 — Rankear por score explicável (Must)
Score = 0.5*desconto% + 0.2*quedaVsHistorico + 0.15*temCupom + 0.1*vendidos + 0.05*avaliação. Salvar `motivo` (“-49% + cupom + 1000 vendidos”).
```gherkin
Dado 50 candidatos
Quando rankeio
Então Top 3 têm score >= corte e motivo legível no log
```

### RF-018 — Modo AUTO vs REVISÃO (Must)
AUTO: se score≥corte e dentro da janela/limite, gera + envia sem humano. REVISÃO: exige approval (RF-008). Padrão inicial REVISÃO.
```gherkin
Dado modo AUTO e score 92
Quando dentro da janela 8h-22h e <10 envios hoje
Então envia sozinho e registra trace+motivo
```

### RF-019 — Anti-duplicidade (Must)
Nunca reenviar mesmo `MLB-ID` com mesmo preço em 7 dias (hash `MLB+precoPix+cupom`).
```gherkin
Dado MLB-4210056475 já enviado ontem pelo mesmo preço
Quando reaparece na varredura
Então é descartado com motivo DUPLICADO_7D
```

### RF-020 — Janela, limite e scheduler (Must)
Cron configurável (default 2h, 8h-22h), limite/dia (default 10), kill-switch `AUTO_OFF` imediato.

### RF-021 — Histórico de preços (Should)
Guardar cada coleta para provar queda real; selo `QUEDA REAL` vs `OFERTA BOA`.

## 4. NFRs novos
- NFR-009 Hunter p95 <90s/50 itens (com cache); sem cache <180s.
- NFR-010 Scorer determinístico (mesmo input = mesmo score).
- NFR-011 AUTO só com `AUTO_APROVADO=true` assinado pelo dono + log imutável.

## 5. RNs novas
- RN-008 Corte default: score ≥75 + desconto ≥30% para AUTO.
- RN-009 Falso De: sem histórico ≥3 pontos, proibir selo `caiu muito`; usar `oferta boa`.
- RN-010 Mesmo MLB só reenvia se preço cair ≥5% adicional.
- RN-011 Template RN-001 inalterado (saída continua igual v0.1).

## 7. Matriz delta v0.2
| RF novo | RN | US nova | Teste |
|---|---|---|---|
| RF-015,016 | — | US-10 | Varredura mock 50 itens |
| RF-017,021 | RN-008,009 | US-11 | Score golden set |
| RF-018,020 | RN-008 | US-12 | AUTO dry-run + kill-switch |
| RF-019 | RN-010 | US-13 | Reenvio bloqueado 7d |

## 8. Risco novo
| Bloqueio search ML por volume | M/Alto | Cache + backoff + intervalo ≥2h + conta reserva |
| Falso desconto queima confiança | A/M | Histórico + RN-009 + flag REVISÃO p/ sem-histórico |
| AUTO dispara demais e toma ban | M/Alto | Limite 10/dia + janela + modo REVISÃO default |
