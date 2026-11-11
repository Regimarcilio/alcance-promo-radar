# ADR-007 — Clientes: contatos dos grupos, listas e campanha com fila anti-bloqueio

> Data: 2026-10-22 | Status: Aceita (implementada; `src/clientes/clientes.test.ts` verde)

## Contexto

Os participantes dos grupos de oferta são a audiência mais valiosa do operador, mas o sistema só
sabia publicar em grupos. Faltava: (a) **colher** esses contatos com segurança, (b) organizá-los em
**listas** de distribuição e (c) **disparar** mensagem individual sem cair no bloqueio do WhatsApp —
disparo em rajada é o gatilho clássico de ban.

## Decisão

**Colheita de contatos** (`src/clientes/clientes.ts`)
- Fonte: `GET /group/participants/{instance}?groupJid=` da Evolution, com deduplicação por telefone,
  somada ao cadastro manual.
- Sync resiliente ao rate-limit: pausa de **8s** entre grupos, backoff de **90s** em `429`/`500`
  (tratados como "talvez rate limit") com 2 tentativas, e **403 ignorado** (grupo inacessível não é
  erro real).
- Persistência atômica em `data/clientes.json` (contatos + listas + `ultimoSync`).

**Listas**
- Listas nomeadas com IDs de contato, para reuso em campanhas.

**Campanha (disparo individual)**
- Fila persistida em `data/clientes-fila.json` — **sobrevive a restart** (itens, `ultimoEnvio`,
  `enviados`, `erros`).
- Ritmo de **1 envio a cada `CLIENTES_INTERVALO_S`** (default **60s**), com prioridade sobre a fila
  do monitor (envio de campanha tem precedência).
- O envio usa o **dispatch normal** (rotação de números), reaproveitando a lógica anti-ban do ADR-006.

**Adição de contatos ao grupo** (`src/monitor/grupo-add.ts`)
- Regras de grupo implementadas como fila com **pausa de 3s** entre adições, **espera de 45s** em
  caso de rate-limit e **3 tentativas** por contato.
- Envio de mensagem tem **prioridade** sobre a adição ao grupo (evita perder a oferta, issue #27).

## Consequências

- **+** Audiência dos grupos vira ativo organizado (contatos + listas) sem trabalho manual.
- **+** Fila persistida: campanha longa sobrevive a restart e o progresso não se perde.
- **+** Ritmo controlado (60s) + rotação de números reduzem drasticamente o risco de ban.
- **+** Sync tolera rate-limit e segue para os próximos grupos em vez de abortar tudo.
- **−** Sync de grupos grandes é lento por design (8s/grupo) — é o preço da segurança.
- **−** Não há gestão de opt-out/descadastro explícita na UI além da remoção manual do contato.
- **−** Campanha de muitos contatos demora horas (1/min): adequado a listas pequenas, não a blast.

## Referências

- Implementação: `src/clientes/clientes.ts`, `src/monitor/grupo-add.ts`, `src/wa/dispatch.ts`
- Testes: `src/clientes/clientes.test.ts` (4)
- SRS: RF-045 (sincronizar contatos e listas), RF-046 (campanha e fila), RF-047 (adição ao grupo em
  gotejamento); RN-019 (sync), RN-020 (campanha), RN-021 (adição ao grupo)
- Issues: #27 (envio tem prioridade sobre adição ao grupo)
