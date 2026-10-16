# 05 — Backlog Scrum — autoMensagemWhats [v0.2 HUNTER]

> v0.2 | 2026-10-12 | Velocidade: 12 pts/sprint | Épico novo E5 Hunter autônomo

## Épicos (v0.1 mantidos + novo)
- E1 Ingestão ML (RF-001/002/003) — agora fallback
- E2 Copy + formato (RF-004/005/006)
- E3 Preview + envio (RF-007/008/009/010)
- E4 Ops (RF-012/013/014)
- **E5 Hunter autônomo (RF-015–021) — foco v0.2**

## US mantidas
US-01 a US-09 inalteradas (ver git v0.1). US-01 vira fallback manual.

## US novas (E5)

### US-10 Como OP quero escolher categoria e filtros e ativar varredura (5pts, Must)
Aceite RF-015. Tarefas: `categorias.json`, CRUD CLI, validação Zod. Teste: salva `Relogios desc30 teto500` e hunter usa.

### US-11 Como SISTEMA quero rankear Top3 com score explicável (5pts, Must)
Aceite RF-017 + RN-008/009. Tarefas: Scorer + `coletas` histórico + selo QUEDA REAL/OFERTA BOA. Teste: golden set 50→3 com motivos.

### US-12 Como ADM quero modo AUTO com janela/limite/kill-switch (5pts, Must)
Aceite RF-018/020. Tarefas: scheduler cron, `AUTO_APROVADO`, janela 8-22h, limite 10/dia, `AUTO_OFF`. Teste: dry-run + kill desliga em <5s.

### US-13 Como SISTEMA quero anti-duplicidade 7d (3pts, Must)
Aceite RF-019/RN-010. Tarefas: hash `MLB+preço+cupom`, índice SQLite. Teste: reenvio mesmo preço bloqueado, queda 5% libera.

## Roadmap v0.2
- **Sprint 1 (Hunter base):** US-10, US-11, US-02, US-05v2 → entrega: escolhe categoria → vê Top3 + novo protótipo.
- **Sprint 2 (AUTO seguro):** US-12, US-13, US-06/07 → entrega: piloto 1 categoria + 1 grupo em REVISÃO → vira AUTO.
- **Sprint 3 (IA+Ops):** US-04, US-08 → entrega: headlines IA + health + plano Cloud.

## Issues novas
`#7 US-10 categorias`, `#8 US-11 scorer`, `#9 US-12 auto`, `#10 US-13 dedup`, milestone `HUNTER-MVP`.
