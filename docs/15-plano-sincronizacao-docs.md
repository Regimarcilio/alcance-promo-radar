# 15 — Plano de Sincronização Documental (SRS v0.4 + ADRs 005–008)

> **STATUS: em execução (2026-10-22).** Plano aprovado e em grande parte executado; ver
> [§9 Status de execução](#9-status-de-execução-2026-10-22) para o que foi concluído e o que resta.
> **Atenção:** a numeração de RF/ADR/épico **proposta** em §3 foi **superada** pela numeração final
> adotada em [`SRS-v0.4.md`](SRS-v0.4.md) (ex.: o RF de rotação é **RF-042**, não RF-041; contatos é
> **RF-045**). Onde divergir, vale o SRS v0.4.

> Criado: 2026-10-21 · Branch `develop` · Responsável: planmaster
> Objetivo: alinhar a documentação ao produto que já roda, restaurando rastreabilidade requisito → código → teste → evidência.
> Documento de referência do estado atual: `docs/14-relatorio-geral.md`.

---

## 1. Diagnóstico (por que este plano existe)

| Documento | Versão | Defasagem | Evidência |
|---|---|---|---|
| `docs/SRS.md` | v0.3 (17/10) | 0 menções a login/auth, multi-número, clientes, `ephemeralMessage`, rotação e paletas | `grep -ic` retorna 0 para os termos |
| `docs/05-backlog.md` | v0.3 (17/10) | Para em US-20; não cobre E6-AUTH, E6-CLIENTES, E6-UI nem MONITOR-13+ | dev-log tem 12 entregas posteriores |
| `README.md` | v0.2 | Nome antigo, porta 8091, sem auth/monitor/clientes | linhas 1, 39–40 |
| `docs/04-ADRs/` | 4 ADRs | Sem decisões de rotação, fila, contatos e temas | diretório |
| `docs/01-visao-e-escopo.md` | v0.2 | Não reflete o Alcance | título do arquivo |

Consequência: um novo desenvolvedor não consegue responder “qual requisito cobre o login?” ou “por que a fila espera 120 s?” sem ler 40 KB de dev-log.

---

## 2. Escopo e não escopo

**IN**
- SRS v0.4 com requisitos das funcionalidades já entregues e critérios de aceite testáveis.
- Backlog v0.4 com épicos, user stories, rastreabilidade e status (entregue/planejado).
- ADRs 005–008 das decisões estruturais recentes.
- README reescrito para o produto Alcance.
- CHANGELOG inicial (v0.8.0) e convenção de release.
- Atualização da visão/escopo e do glossário.

**OUT**
- Reescrever a arquitetura inteira ou refatorar código.
- Documentar funcionalidades não entregues (ex.: Cloud API, multiusuário).
- Criar protótipos novos.
- Alterar o comportamento do produto.

---

## 3. Entregáveis e critérios de aceite

### 3.1 SRS v0.4

**Novos requisitos funcionais propostos:**

| ID | Requisito | Prioridade | Evidência de entrega |
|---|---|---|---|
| RF-040 | Autenticar operador no painel com sessão e default-deny | Must | `src/manager/auth.ts`, E6-AUTH-02 |
| RF-041 | Rotacionar envios entre múltiplos números com peso e limite | Must | `src/wa/rotacao.ts`, `data/instancias.json` |
| RF-042 | Sincronizar contatos dos grupos e manter listas | Must | `src/clientes/clientes.ts`, 6.147 contatos |
| RF-043 | Enfileirar rajadas do monitor (1 envio a cada N segundos) | Must | `src/monitor/fila.ts`, `MONITOR_FILA_INTERVALO_S` |
| RF-044 | Aplicar mensagens temporárias de 7 dias no destino | Should | `ephemeralMessage`, E6-MONITOR-19 |
| RF-045 | Oferecer 6 temas/paletas e títulos editáveis por painel | Should | `server.ts`, `src/ui/titulos.ts` |
| RF-046 | Enriquecer Amazon por ASIN com fallback de foto/título | Should | `src/monitor/amazon-api.ts`, E6-MONITOR-17/18 |
| RF-047 | Navegar por views dinâmicas na sidebar | Could | E6-MONITOR-22 |

**Novos NFRs propostos:**

| ID | Requisito | Métrica / verificação |
|---|---|---|
| NFR-009 | TLS obrigatório para acesso fora de loopback | `https` + HSTS; teste com `curl -k` rejeitado sem TLS |
| NFR-010 | Container non-root e `data/` com ownership do host | `id -u` ≠ 0; escrita/leitura no host |
| NFR-011 | Observabilidade mínima: health, métricas de fila/erro | endpoint `/health` + contadores |
| NFR-012 | Backup/restore do estado JSON | restore em <10 min; teste documentado |
| NFR-013 | Retenção e rotação de logs de auditoria | 30 dias; sem PII |

**Critérios de aceite do SRS v0.4 (DoD documental):**
- [ ] 100% das funcionalidades em produção têm RF com ator, descrição, prioridade e Gherkin.
- [ ] Nenhum RF sem critério de aceite testável.
- [ ] Matriz de rastreabilidade RF × RN × US × teste × commit preenchida.
- [ ] Glossário cobre termos novos (sessão, paleta, rotação, rajada, ASIN, JID).
- [ ] Revisão de consistência contra `docs/14-relatorio-geral.md` (sem requisito fantasma).

### 3.2 Backlog v0.4

**Novos épicos:**

| Épico | Escopo | US propostas |
|---|---|---|
| E7 — Autenticação e segurança | login, sessão, rate-limit, auditoria | US-21 a US-23 |
| E8 — Clientes | sync de contatos, listas, campanha | US-24 a US-26 |
| E9 — Multi-número | rotação, peso, limite, QR | US-27 a US-29 |
| E10 — UI/Temas | sidebar, paletas, títulos, cards | US-30 a US-32 |

**Regras:**
- Marcar como `ENTREGUE` as US já em produção, com link para a entrada do `dev-log` e para o commit.
- Não renumerar US-01..US-20; novas histórias entram a partir de US-21.
- Cada US deve ter: história, AC Gherkin, tasks, teste, dependências e status.

**Critérios de aceite:**
- [ ] Backlog cobre 100% dos RFs do SRS v0.4.
- [ ] Nenhuma US “entregue” sem evidência (commit, teste ou saída de comando).
- [ ] Roadmap separa entregue, em curso e próximo.
- [ ] DoR/DoD explícitos.

### 3.3 ADRs 005–008

| ADR | Título | Decisão a registrar | Alternativas descartadas |
|---|---|---|---|
| ADR-005 | Rotação multi-número | Peso por instância, limite diário, janela 8h–22h, jitter | Número único; rotação round-robin pura |
| ADR-006 | Fila anti-rajada do monitor | Liberar 1 envio a cada N s (default 120 s), persistida em JSON | Envio imediato; delay fixo por mensagem |
| ADR-007 | Fonte de contatos | `GET /group/participants/{instance}` + dedup por telefone | Importação manual; scraping de agenda |
| ADR-008 | Temas e títulos por painel | 6 paletas via `data-paleta` + `localStorage` + títulos em JSON | Tema único; CSS por usuário no servidor |

**Formato obrigatório:** Contexto · Decisão · Consequências · Alternativas · Data · Status.
**Critério de aceite:** cada ADR referencia o código e o commit que a implementou.

### 3.4 README e CHANGELOG

**README (novo):**
- Nome **Alcance**, propósito e arquitetura em 5 linhas.
- Quickstart real: `npm ci`, `.env`, `npm run auth:user`, `npm run build`, `npm run manager`.
- Porta **8099** (localhost) e aviso de TLS antes de LAN.
- Seções: monitor, clientes, multi-número, temas, testes, deploy, segurança.
- Remover instruções mortas (porta 8091, nome autoMensagemWhats, cron antigo).

**CHANGELOG:**
- `CHANGELOG.md` com `0.8.0` (data, added/changed/fixed/security).
- Convenção: Keep a Changelog + SemVer.
- Primeira entrada referencia os épicos E6.

**Critérios de aceite:**
- [ ] Um clone limpo consegue subir o painel seguindo só o README.
- [ ] Nenhuma referência a 8091/nome antigo.
- [ ] CHANGELOG cobre auth, monitor, clientes, multi-número, temas e Amazon.

---

## 4. Sequência de execução (2 sprints de documentação)

### Sprint D1 — Requisitos e decisões (5 dias)
1. Extrair RFs/NFRs do código e do dev-log (inventário).
2. Revisar com o usuário os 8 RFs e 5 NFRs propostos.
3. Publicar SRS v0.4.
4. Publicar ADRs 005–008.

### Sprint D2 — Execução e comunicação (5 dias)
5. Publicar backlog v0.4 com rastreabilidade e status.
6. Reescrever README + CHANGELOG.
7. Rodar revisão de consistência (checklist §5).
8. Abrir issues/milestone e commitar em `develop`.

---

## 5. Checklist de consistência (gate final)

- [ ] Todo RF tem AC Gherkin e ao menos um teste ou evidência manual.
- [ ] Todo RF aparece em pelo menos uma US.
- [ ] Toda US entregue aponta para commit/entrada do dev-log.
- [ ] Todo ADR aponta para código e commit.
- [ ] README não cita porta/nome/comando inexistente.
- [ ] Nenhum documento usa telefone, JID ou convite real (usar placeholders).
- [ ] Links internos entre docs funcionam.
- [ ] `docs/14-relatorio-geral.md` e SRS não se contradizem.

---

## 6. Riscos do plano

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| SRS virar cópia do código | Média | Alto | Escrever requisito antes de citar arquivo; revisar com o usuário |
| Backlog inflar com US retroativas | Alta | Médio | Marcar status `ENTREGUE` e não replanejar esforço |
| ADRs virarem justificativa post-hoc | Média | Médio | Registrar alternativas e trade-offs reais |
| Documentação envelhecer de novo | Alta | Alto | Incluir atualização de docs no DoD de toda feature |
| Exposição de PII na publicação | Baixa | Alto | Placeholders + revisão antes de cada push |

---

## 7. Métricas de sucesso

| Métrica | Antes | Meta |
|---|---:|---:|
| RFs documentados / funcionalidades em produção | 22 / ~32 | 100% |
| US com evidência | 20 / 20 | 100% das entregues |
| ADRs de decisões estruturais | 4 | 8 |
| Tempo para um novo dev entender o escopo | > 1 dia | < 2 h |
| Docs atualizados no último mês | 2 | 100% dos docs vivos |

---

## 8. Próxima ação

1. Aprovar os RFs/NFRs propostos (ou ajustar).
2. Criar as 4 issues de documentação no repositório.
3. Executar Sprint D1 e abrir PR de `docs/srs-v0.4` para `develop`.

---

## 9. Status de execução (2026-10-22)

### Concluído

| Item | Arquivo | Observação |
| --- | --- | --- |
| Índice mestre de documentos | `docs/00-INDICE.md` | Tabela documento × versão × status × substitui |
| SRS consolidado | `docs/SRS-v0.4.md` | RF-001..RF-056, RN-001..RN-027, NFRs, matriz de rastreabilidade, cobertura de 99 testes, riscos e glossário |
| Banners de histórico | `docs/12-…`, `docs/14-…`, `docs/06-…`, `docs/08-…` | Conteúdo preservado; status “retrato histórico” |
| ADRs das decisões estruturais | `docs/04-ADRs/ADR-005`, `ADR-006`, `ADR-007`, `ADR-008` | Títulos e escopos conforme mapeamento aprovado pelo usuário |
| Índice de ADRs | `docs/04-ADRs/README.md` | Status atual + mapa ADR × RF × RN |
| Padrão de mensagem | `docs/11-padrao-emipe.md` | v2 (histórica) + **RN-001 v3** real, fiel a `src/wa/formatter.ts` |
| CHANGELOG | `CHANGELOG.md` | Keep a Changelog + SemVer; `0.8.0` + `[Unreleased]` |
| Backlog v0.4 | `docs/05-backlog-v0.4.md` | US-21+, DoR/DoD, estados e matriz RF → US cobrindo 100% dos RF |
| README | `README.md` | Nome Alcance, quickstart real, dois fluxos Docker, persistência JSON, 99 testes |

### Divergências de numeração (plano §3 → SRS v0.4 final)

| Tema | ID no plano (§3) | ID final no SRS v0.4 |
| --- | --- | --- |
| Rotação multi-número | RF-041 | **RF-042** |
| Sincronizar contatos/listas | RF-042 | **RF-045** |
| Fila anti-rajada do monitor | RF-043 | **RF-043** (coincide) |
| Temas/títulos por painel | RF-045 | **RF-048** (views/títulos) e **RF-049** (temas) |
| Rate-limit/auditoria | (não previsto) | **RF-041** |

Os ADRs 005–008 foram redigidos já com a numeração **final** do SRS v0.4 para não propagar IDs
fantasma.

### Pendente

- [x] **Backlog v0.4** (`docs/05-backlog-v0.4.md`) com épicos E7–E13, US-21+ e status + evidência.
- [ ] **`docs/01-visao-e-escopo.md`** para a versão Alcance.
- [ ] Revisão final do **checklist §5** e abertura das issues/milestone no repositório.
- [ ] Commits de documentação em `develop` (Conventional Commits `docs(plan): …`).
- [ ] (Opcional) Finalizar os itens de `[Unreleased]` do CHANGELOG: comentários de código com RF
      desatualizado (`src/jobs/auto.ts` “22h”; `src/monitor/fila.ts` “RF-036”).

> Itens de código (não-docs) estão fora do escopo deste plano e não foram tocados.
