# 05 — Backlog Scrum — promo-radar-novo [v0.3 AUTOMÁTICO + MONITOR]

> v0.3 | 2026-10-17 | Velocidade: 12 pts/sprint | Épicos E1–E5 mantidos + **E6 Monitor (novo)**

## Épicos (v0.1/v0.2 mantidos + novo)
- E1 Ingestão ML (RF-001/002/003) — agora fallback
- E2 Copy + formato (RF-004/005/006)
- E3 Preview + envio (RF-007/008/009/010)
- E4 Ops (RF-012/013/014)
- E5 Hunter autônomo (RF-015–021) — foco v0.2
- **E6 Monitor de grupos (RF-030–035) — foco v0.3. Convive com E1–E5 na mesma interface.**

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

### US-14 Como OP quero escolher qtd (1 ou 2) e intervalo (45/60/90s) ao criar loop (3pts, Must)
Aceite RF-022/023. Tarefas: adicionar campos `qtd` e `intervaloS` no `PilotoCfg`, atualizar tela de START no manager, validar que `enviadasAqui <= qtd` no ciclo, registrar no log o respiro humano. Teste: loop com qtd=2 envia 2 msg com intervalo correto; loop com qtd=1 envia apenas 1.

### US-15 Como SISTEMA quero jitter humano ±10s no intervalo entre postagens (2pts, Should)
Aceite RF-023. Tarefas: implementar `Math.random() * 20 - 10` sobre o intervalo base, evitar padrão cravejado que denuncia robô. Teste: 10 execuções do mesmo loop mostram variações de tempo dentro do esperado (não exatamente iguais).

## US novas (E6 — Monitor)

### US-16 Como OP quero cadastrar até 10 grupos de afiliados para monitorar (5pts, Must)
Aceite RF-030. Tarefas: CRUD `data/monitor-grupos.json` (lista de origem + destino), endpoints `GET/POST/DELETE /api/monitor/grupos`, webhook Evolution (`messages.upsert`) → `POST /api/webhook/evolution` com header `X-Webhook-Key`. Teste: mensagem no grupo de teste "INVITE_REDACTED_0000000" entra no pipeline; grupo não cadastrado é ignorado.

### US-17 Como SISTEMA quero identificar oferta e programa de afiliado (5pts, Must)
Aceite RF-031 + RN-008/009. Tarefas: parser de URLs em texto livre, allowlist de domínios (ML/`meli.la`, Shopee/`shope.ee`, Kabum, Amazon/`amzn.to`), extração de MLB/ASIN. Teste: 1 link de cada programa reconhecido; domínio fora da lista → `NAO_RECONHECIDO`.

### US-18 Como SISTEMA quero transformar o link para o meu link de afiliado (5pts, Must)
Aceite RF-032 + RN-012. Tarefas: reutilizar `src/ml/provider.ts` (`converterLink`) com tag/cookie já configurados; falha de cookie → fila `REVISAO_MONITOR`. **Shopee:** `src/monitor/shopee-api.ts` com `generateShortLink` (Open API), assinatura SHA-256, cache 6h, `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`/`SHOPEE_SUB_IDS`; sem credenciais/falha → revisão, `smtt` legado não conta como afiliado. Teste: link original vira link com tag do usuário (nunca perfil); link sem transformação válida não é enviado; Shopee com mock retorna `shope.ee/...` e falha mantém original em revisão.

### US-19 Como SISTEMA quero aplicar meu template e encaminhar aos meus grupos (5pts, Must)
Aceite RF-033/034 + RN-011/013. Tarefas: aplicar RN-001 ao texto recebido, encaminhar via `src/wa/dispatch.ts` para o grupo de destino, registrar `messageId`, somar contador diário compartilhado (RN-007/RN-013). Teste: mensagem completa (texto+preço+link) sai no padrão Emipe com link transformado no grupo de destino.

### US-20 Como SISTEMA quero anti-loop e dedup do monitor (3pts, Must)
Aceite RF-035 + RN-010. Tarefas: bloquear destino = origem; hash 7d `programa+idProduto+linkTransformado` em `data/envios-monitor.json`. Teste: mesma mensagem reaparecida → `DUPLICADO_MONITOR`, não reenvia; nenhum destino é a origem.

## Roadmap v0.2 (AUTOMÁTICO)
- **Sprint 1 (Hunter base):** US-10, US-11, US-02, US-05v2 → entrega: escolhe categoria → vê Top3 + novo protótipo.
- **Sprint 2 (AUTO seguro):** US-12, US-13, US-06/07 → entrega: piloto 1 categoria + 1 grupo em REVISÃO → vira AUTO.
- **Sprint 3 (IA+Ops):** US-04, US-08 → entrega: headlines IA + health + plano Cloud.
- **Sprint 4 (Loop qtd/intervalo):** US-14, US-15, US-16 → entrega: loop configurável + primeiro grupo monitorado.

## Roadmap v0.3 (MONITOR)
- **Sprint 5 (Monitor base):** US-16, US-17 → entrega: 1 grupo de teste monitorado, link ML reconhecido e transformado.
- **Sprint 6 (Multi-programa):** US-18 (Shopee/Kabum/Amazon) → entrega: 4 programas no parser.
- **Sprint 7 (Template + fan-out):** US-19 → entrega: template aplicado + encaminhamento aos grupos próprios.
- **Sprint 8 (Segurança/anti-loop):** US-20 → entrega: dedup, anti-loop, limite compartilhado, kill-switch do monitor.

## Issues novas
`#7 US-10 categorias`, `#8 US-11 scorer`, `#9 US-12 auto`, `#10 US-13 dedup`, `#11 US-14 qtd/intervalo`, `#12 US-16 monitor grupos`, `#13 US-17 parser afiliados`, `#14 US-18 transformer`, `#15 US-19 template+forward`, `#16 US-20 anti-loop`. Milestones: `HUNTER-MVP` (E1–E5), `MONITOR-MVP` (E6).
