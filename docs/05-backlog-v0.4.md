# 05 — Backlog Scrum v0.4 — Alcance (promo-radar)

> v0.4 | 2026-10-22 | Branch `develop` | Versão do produto: `0.8.0` (64 commits)
> Fonte de requisitos: [`SRS-v0.4.md`](SRS-v0.4.md) · Decisões: [`04-ADRs/`](04-ADRs/README.md)
> Velocidade de referência: **12 pts/sprint** · Substitui [`05-backlog.md`](05-backlog.md) (v0.3).
> Este backlog **cobre 100% dos RF do SRS v0.4** (matriz em §7). Histórias já em produção ficam como
> `ENTREGUE` com evidência, sem replanejamento de esforço.

## 1. Estados usados

| Estado | Significado |
| --- | --- |
| `ENTREGUE` | Está em produção no `develop` atual, com evidência (commit/teste/entrada no dev-log). |
| `ENTREGUE (parcial)` | Parte do requisito está pronta; o restante está explicitado na própria US. |
| `PRÓXIMO` | Escopo aprovado, ainda não implementado. |
| `ADIADO` | Fora do foco atual; retoma quando o RF correspondente voltar à pauta. |
| `LEGADO` | Só existe no CLI antigo (`src/jobs/auto.ts`); não é fluxo vigente do painel. |
| `REMOVIDO` | Não vira história; requisito retirado do escopo (ver SRS §1.5). |

## 2. DoR / DoD

**Definition of Ready (DoR)** — uma US só entra em sprint com:
1. RF do SRS com **ator, descrição, prioridade e critério de aceite Gherkin**.
2. Se a US tem **tela/tema/UX**, o protótipo precisa estar **APROVADO** (rotina de prototipação;
   nenhuma tela entra em implementação sem protótipo aprovado).
3. Dependências resolvidas e estimativa de pontos acordada.
4. Contrato de entrada/saída (rota, arquivo, variável de ambiente) definido.
5. Estratégia de teste descrita (qual AC → qual arquivo em `src/**/*.test.ts`).

**Definition of Done (DoD)** — uma US só fecha com:
1. Código integrado em `develop` via PR revisado.
2. Critério de aceite Gherkin atendido, com teste automatizado correspondente verde (`node:test`).
3. Suíte completa verde (**118 testes em 21 arquivos**) e sem regressão.
4. `kalimaster-sast` limpo no diff do PR.
5. **Entrada no `docs/dev-log.md`** com `task_id`, decisões, arquivos e resultado dos testes.
6. RF/RN citados no código/PR; `CHANGELOG.md` atualizado quando a mudança é visível ao operador.

## 3. Épicos

| Épico | Escopo | RFs | Estado |
| --- | --- | --- | --- |
| E1 — Ingestão ML | cadastro por URL, enriquecimento, cesta | RF-001..003 | parcial/legado |
| E2 — Copy + formato | template RN-001, IA (stub), formatter | RF-004..006 | entregue; IA adiada |
| E3 — Preview + envio | preview, approval, provider, agendamento | RF-007..010 | parcial/legado |
| E4 — Ops | histórico, health, observabilidade, PII | RF-011..014 | parcial; PII removida |
| E5 — Hunter autônomo | categoria, hunt, score, anti-dup, janela, histórico | RF-015..021 | parcial |
| E6 — Monitor de grupos | grupos, parser, transformer, fan-out, anti-loop | RF-030..035 | entregue |
| **E7 — Autenticação e segurança** | login, sessão, rate-limit, auditoria, 2FA | RF-036, RF-040, RF-041 | **entregue** |
| **E8 — Clientes** | sync de contatos, listas, campanha, adição ao grupo | RF-045..047 | **entregue** |
| **E9 — Multi-número** | rotação ponderada, todos os abertos enviam, QR/loops | RF-042, RF-054, RF-055 | **entregue** |
| **E10 — UI/Temas** | views, títulos editáveis, paletas | RF-048, RF-049 | **entregue** |
| **E11 — Dados e rastreio** | cupons, contas/tag/mapa, rastreio de publicações | RF-050..052 | **entregue** |
| **E12 — Monitor (evolução)** | permissões, cache de grupos, fila anti-rajada, favoritos | RF-037, RF-043, RF-053, RF-056 | **entregue** |
| **E13 — Evolução e pendências** | efêmeras, health cookie, IA, histórico de preços, observabilidade | RF-005, RF-007, RF-008, RF-009, RF-011, RF-012, RF-013, RF-016, RF-002 | parcial/adiado |

## 4. US legadas (US-01..US-20) — mapa e estado

As histórias US-01..US-09 (v0.1) estão preservadas no git v0.1; US-10..US-20 estão em
[`05-backlog.md`](05-backlog.md) (v0.3). Mapa de cobertura no estado atual:

| US | Tema | RFs | Estado atual |
| --- | --- | --- | --- |
| US-01..US-09 | Ingestão, template, preview, envio, ops (v0.1) | RF-001..RF-014 | `ENTREGUE`/`parcial`/`REMOVIDO` conforme SRS |
| US-10 | Categoria, filtros e varredura | RF-015 | `ENTREGUE` |
| US-11 | Rankear Top3 com score explicável | RF-017 | `ENTREGUE` |
| US-12 | Modo AUTO com janela/kill-switch | RF-018, RF-020 | `LEGADO` (janela 8h–23h segue; sem limite diário) |
| US-13 | Anti-duplicidade do Piloto | RF-019 | `ENTREGUE` |
| US-14 | Qtd e intervalo por ciclo | RF-022 | `ENTREGUE` |
| US-15 | Jitter humano no intervalo | RF-023 | `ENTREGUE` |
| US-16 | Cadastrar grupos para monitorar | RF-030 | `ENTREGUE` |
| US-17 | Identificar oferta e programa | RF-031 | `ENTREGUE` |
| US-18 | Transformar para link de afiliado | RF-032 | `ENTREGUE (parcial)` (Shopee/Amazon ok; Kabum pendente) |
| US-19 | Aplicar template e encaminhar | RF-033, RF-034 | `ENTREGUE` (contador diário da RN-013 removido) |
| US-20 | Anti-loop e dedup do monitor | RF-035 | `ENTREGUE` |

## 5. US novas (US-21+) — E7 a E13

### E7 — Autenticação e segurança

#### US-21 — Login, sessão e default-deny (Must · 5 pts)
**Como** operador, **quero** acessar o painel com sessão segura, **para** que ninguém use as ações
sensíveis sem credencial.
- **Aceite (RF-040, RN-017):** rota sensível sem sessão responde 401/redirect; login válido cria o
  cookie `alcance_sid` (HttpOnly/SameSite=Strict); TTL absoluto 8 h e idle 30 min; máximo 5 sessões
  por usuário; logout invalida a sessão.
- **Tarefas:** `src/manager/auth.ts`, gate no `src/manager/server.ts`, `scripts/auth-user.mjs`.
- **Teste:** `manager/auth.test.ts` (7). **Dep.:** —.
- **Status:** `ENTREGUE` (commits `ef19144`, #21; ADR-005).

#### US-22 — Verificação de celular (2FA) no 1º acesso (Must · 5 pts)
**Como** operador, **quero** confirmar um código enviado ao meu WhatsApp, **para** amarrar a conta a
um celular real.
- **Aceite (RF-036, RN-018):** código de 10 posições (sem 0/O/1/I), validade 10 min, trava em 5
  tentativas, hash SHA-256 com sal (texto puro nunca no disco); login responde
  `{ precisaCodigo, telefone: "•••" }` mascarado; usuário sem telefone entra só com senha.
- **Tarefas:** `src/manager/verificacao.ts`, `scripts/auth-user.mjs --telefone`, rota de reenvio.
- **Teste:** `manager/verificacao.test.ts` (8). **Dep.:** US-21.
- **Status:** `ENTREGUE` (#21; ADR-005, ADR-010).

#### US-23 — Rate-limit, auditoria e headers (Must · 3 pts)
**Como** operador, **quero** proteção contra força bruta e rastro de acesso, **para** auditar e conter
abuso de login.
- **Aceite (RF-041):** 5 tentativas/min por IP com bloqueio 60 s e teto global 30/min; eventos
  gravados em JSONL com IP truncado em `/24`; headers de segurança aplicados.
- **Tarefas:** núcleo de rate-limit e `auditar()` no `src/manager/auth.ts`/`server.ts`.
- **Teste:** `manager/auth.test.ts` (rate-limit). **Dep.:** US-21.
- **Status:** `ENTREGUE` (#21; ADR-005).

### E8 — Clientes

#### US-24 — Sincronizar contatos dos grupos e listas (Must · 5 pts)
**Como** operador, **quero** puxar os participantes dos meus grupos para listas, **para** falar
individualmente sem cadastro manual.
- **Aceite (RF-045, RN-019):** `GET /group/participants/{instance}?groupJid=`, dedup por telefone,
  pausa de 8 s entre grupos, backoff de 90 s em 429/500, 403 ignorado; listas nomeadas persistidas.
- **Tarefas:** `src/clientes/clientes.ts` (+ `data/clientes.json`).
- **Teste:** `clientes/clientes.test.ts` (4). **Dep.:** US-21, US-27.
- **Status:** `ENTREGUE` (#10, #13; ADR-007).

#### US-25 — Campanha e fila de clientes (Must · 5 pts)
**Como** operador, **quero** disparar uma mensagem individual em fila, **para** alcançar clientes sem
bloqueio.
- **Aceite (RF-046, RN-020):** um envio a cada `CLIENTES_INTERVALO_S` (default 60 s), fila persistida
  em `data/clientes-fila.json` (sobrevive a restart), progresso `enviados`/`erros`; envio usa rotação.
- **Tarefas:** fila + worker em `src/clientes/clientes.ts`, uso de `src/wa/dispatch.ts`.
- **Teste:** manual + `clientes/clientes.test.ts`. **Dep.:** US-24, US-27, US-31.
- **Status:** `ENTREGUE` (#10; ADR-007).

#### US-26 — Adicionar contatos ao grupo em gotejamento (Must · 5 pts)
**Como** operador, **quero** adicionar contatos ao grupo devagar, **para** não tomar bloqueio do
WhatsApp.
- **Aceite (RF-047, RN-021):** um contato por vez, pausa 3 s, espera 45 s em limite, 3 tentativas;
  envio de oferta tem prioridade sobre a adição.
- **Tarefas:** `src/monitor/grupo-add.ts`, prioridade em `src/wa/dispatch.ts`.
- **Teste:** `monitor/evolution.test.ts` (parcial). **Dep.:** US-27.
- **Status:** `ENTREGUE` (#22, #27; ADR-007).

### E9 — Multi-número

#### US-27 — Rotação de números com peso e principal (Must · 5 pts)
**Como** operador, **quero** distribuir os envios entre vários números, **para** reduzir risco de
banimento.
- **Aceite (RF-042, RN-016):** até 5 instâncias; peso 1–10; só ativas e `open`; anti-repetição 70%
  (`RODIZIO_EVITA_REPETICAO`); todos os abertos enviam, inclusive o principal, na proporção do peso;
  principal preferido para serviço; fallback a ativo se nenhum estiver `open`; dispatch com 3 retries
  transitórios.
- **Tarefas:** `src/wa/rotacao.ts`, `src/wa/dispatch.ts` (+ `data/instancias.json`).
- **Teste:** `wa/rotacao.test.ts` (11). **Dep.:** —.
- **Status:** `ENTREGUE` (#28; ADR-006).

#### US-28 — Gerenciar instâncias: QR, conectar e desconectar (Should · 5 pts)
**Como** operador, **quero** parear/reiniciar/remover números pelo painel, **para** manter a frota
saudável.
- **Aceite (RF-054):** criar instância retorna QR; conectar/desconectar/remover disponíveis; webhook
  configurado no pareamento.
- **Tarefas:** `src/wa/rotacao.ts` (`adicionarInstancia`, `qrInstancia`, `removerInstancia`),
  aba Números no `src/manager/server.ts`.
- **Teste:** manual + `wa/rotacao.test.ts` (parcial). **Dep.:** US-21, US-27.
- **Status:** `ENTREGUE` (ADR-006).

#### US-29 — Retomada de loops após reinício (Should · 3 pts)
**Como** operador, **quero** que os loops voltem sozinhos depois de um restart, **para** não ficar com
o Piloto mudo.
- **Aceite (RF-055):** ao subir, timers são reagendados e loops parados são sinalizados; botão
  "religar" disponível.
- **Tarefas:** `src/ml/piloto.ts`, `src/manager/server.ts`.
- **Teste:** manual. **Dep.:** US-27.
- **Status:** `ENTREGUE` (#17, #18, #23; ADR-006).

### E10 — UI/Temas

#### US-30 — Views dinâmicas e títulos editáveis (Should · 3 pts)
**Como** operador, **quero** navegar por abas e renomear cards, **para** adaptar o painel ao meu
vocabulário.
- **Aceite (RF-048):** sidebar com views dinâmicas sem reload; títulos por card persistidos em
  `data/ui.json` (até 60 caracteres; vazio/desconhecido rejeitado).
- **Tarefas:** `src/manager/server.ts`, `src/ui/titulos.ts`.
- **Teste:** `manager/pagina.test.ts` (3). **Dep.:** US-21.
- **Status:** `ENTREGUE` (`c41f6bf`, `f016e66`; ADR-008).

#### US-31 — Temas (Should · 3 pts)
**Como** operador, **quero** escolher a paleta do painel, **para** adequar a aparência ao meu gosto.
- **Aceite (RF-049, RN-022):** 6 paletas (`verde`, `laranja`, `areia`, `grafite`, `marrom`, `cacau`)
  via `data-paleta`; escolha persistida em `localStorage`; valor inválido cai em `verde`; sem flash.
- **Tarefas:** CSS de paletas + seletor em `src/manager/server.ts`.
- **Teste:** `manager/pagina.test.ts`. **Dep.:** US-30.
- **Status:** `ENTREGUE` (`91393c5`, `887d33d`, `924c03a`; ADR-008).

### E11 — Dados e rastreio

#### US-32 — Cupons do Mercado Livre (Should · 3 pts)
**Como** operador, **quero** colher cupons do ML, **para** incluí-los nas ofertas.
- **Aceite (RF-050):** cupom em caixa alta no template (RN-003); bloco omitido quando vazio.
- **Tarefas:** `src/ml/cupons.ts`, integração no `src/ml/piloto.ts`.
- **Teste:** cobertura via `monitor/transformer.test.ts`/manual. **Dep.:** —.
- **Status:** `ENTREGUE`.

#### US-33 — Contas ML, tag e mapa categoria → grupo (Should · 5 pts)
**Como** operador, **quero** associar tag e grupo por categoria, **para** publicar no destino certo.
- **Aceite (RF-051):** múltiplas contas/tags; mapa categoria→grupo aplicado no envio.
- **Tarefas:** `src/ml/contas.ts`, `src/manager/server.ts`.
- **Teste:** manual. **Dep.:** US-21.
- **Status:** `ENTREGUE`.

#### US-34 — Rastreio de publicações (Should · 3 pts)
**Como** operador, **quero** ver o que foi publicado e quando, **para** conferir volume e reenviar.
- **Aceite (RF-052, RN-027):** guarda o link exato publicado, limite de 5000 registros.
- **Tarefas:** `src/store/publicacoes.ts`, aba Rastreio no `src/manager/server.ts`.
- **Teste:** `store/publicacoes.test.ts` (4). **Dep.:** US-19 (legado).
- **Status:** `ENTREGUE` (#16).

### E12 — Monitor (evolução)

#### US-35 — Permissões de grupo (Should · 3 pts)
**Como** operador, **quero** deixar o grupo "só admins falam", **para** manter o modo anúncio.
- **Aceite (RF-053):** alternar permissões de mensagem/comentário exige conta admin; erro tratado.
- **Tarefas:** `src/monitor/evolution.ts`, aba Monitor.
- **Teste:** `monitor/evolution.test.ts` (parcial). **Dep.:** US-27.
- **Status:** `ENTREGUE` (#12).

#### US-36 — Cache de grupos da Evolution (Should · 3 pts)
**Como** operador, **quero** que a lista de grupos abra instantânea, **para** não esperar a Evolution.
- **Aceite (RF-056):** lista com TTL de 10 min, revalidação em background (stale-while-revalidate) e
  fallback em cache quando a Evolution falha.
- **Tarefas:** `src/monitor/evolution.ts`.
- **Teste:** `monitor/evolution.test.ts`. **Dep.:** —.
- **Status:** `ENTREGUE` (#14, #25, #26).

#### US-37 — Fila anti-rajada do monitor (Must · 3 pts)
**Como** sistema, **quero** enfileirar rajadas, **para** respeitar o limite do WhatsApp.
- **Aceite (RF-043, RN-015):** a partir da 4ª mensagem/min da mesma origem entra na fila; liberação
  1 envio a cada `MONITOR_FILA_INTERVALO_S` (default 120 s); prioriza envio de oferta.
- **Tarefas:** `src/monitor/fila.ts` (**comentário no código diz "RF-036" — canônico é RF-043**).
- **Teste:** `monitor/fila.test.ts` (3). **Dep.:** US-19 (legado).
- **Status:** `ENTREGUE` (`2b3f4ae`).

#### US-38 — Favoritos do Mercado Livre (Should · 2 pts)
**Como** operador, **quero** registrar as ofertas divulgadas nos favoritos do ML, **para** centralizar
a vitrine.
- **Aceite (RF-037):** `POST /users/me/bookmarks` com `ML_ACCESS_TOKEN`; sem token o módulo é inerte;
  falha nunca derruba a publicação.
- **Tarefas:** `src/ml/favoritos.ts`, chamada no `src/ml/piloto.ts`.
- **Teste:** `ml/favoritos.test.ts` (5). **Dep.:** —.
- **Status:** `ENTREGUE` (#21; ADR-010).

### E13 — Evolução e pendências

#### US-39 — Mensagens temporárias de 7 dias no destino (Should · 5 pts)
**Aceite (RF-044):** enviar as ofertas do monitor como mensagem efêmera de 7 dias no destino.
- **Nota:** hoje o código **apenas desembrulha** `ephemeralMessage` na leitura; **não envia** como
  efêmera. O commit `c0b4667` documentava a ativação, mas o SRS v0.4 marca como **Não implementado**.
- **Tarefas:** `src/monitor/webhook.ts`, `src/wa/dispatch.ts`. **Dep.:** US-37.
- **Status:** `PRÓXIMO`.

#### US-40 — Health-check de cookie/sessão do ML (Should · 3 pts)
**Aceite (RF-012):** detectar cookie/tag inválidos e alertar antes de falhar a coleta.
- **Status:** `ADIADO`.

#### US-41 — Variações de copy com IA (Should · 5 pts)
**Aceite (RF-005, RN-005):** IA só sugere headline/subtítulo; **nunca** altera preço/link/cupom. Hoje
é *stub* determinístico. **Status:** `ADIADO` (retomar com `src/ai/gateway.ts`).

#### US-42 — Histórico de preços (Should · 5 pts)
**Aceite (RF-021):** guardar série de preços por produto para selo de "queda real". **Status:**
`ADIADO`.

#### US-43 — Preview fiel da mensagem (Must · 3 pts)
**Aceite (RF-007):** render da mensagem como o WhatsApp entrega (negrito, preço, cupom). Hoje
`Histórico/Parcial`. **Status:** `PRÓXIMO`.

#### US-44 — Observabilidade (Should · 3 pts)
**Aceite (RF-013):** health, contadores de fila/erro e latência mínima. **Status:** `PRÓXIMO`
(parcial: logs e estados existem).

#### US-45 — Enriquecer dados do produto no ML (Must · 5 pts)
**Aceite (RF-002):** título/preço/foto consistentes a partir de `src/ml/provider.ts`/
`src/ml/item-page.ts`. **Status:** `ENTREGUE (parcial)`.

#### US-46 — Hunter autônomo por categoria (Must · 5 pts)
**Aceite (RF-016):** caçar oportunidades por categoria (`src/hunter/service.ts`, `src/ml/hub.ts`).
**Status:** `ENTREGUE (parcial)`.

#### US-47 — Histórico e reenvio (Should · 3 pts)
**Aceite (RF-011):** histórico do que foi enviado e reenvio (`src/store/publicacoes.ts`). **Status:**
`ENTREGUE (parcial)`.

#### US-48 — Provider de envio abstraído (Must · 3 pts)
**Aceite (RF-009):** interface `DispatchProvider`; MVP Evolution. Cloud **não** implementado.
**Status:** `ENTREGUE (parcial)` (ver ADR-001).

#### US-49 — Approval gate de lote (Must · 3 pts)
**Aceite (RF-008):** aprovação antes de lote > 1. Existe **somente no CLI legado**. **Status:**
`LEGADO`.

## 6. Roadmap

**Entregue (E6–E12)** — auth/2FA, clientes/campanhas, multi-número, temas/views, cupons, contas/tag,
rastreio, permissões, cache de grupos, fila anti-rajada, favoritos. Corresponde às issues #10–#28.

**Em curso / curto prazo**
- Estabilização de documentação (SRS v0.4, ADRs, este backlog) e validação do checklist de
  consistência.

**Próximo (E13)**
- US-39 (efêmeras), US-43 (preview fiel), US-44 (observabilidade).

**Adiado**
- US-40 (health cookie), US-41 (IA), US-42 (histórico de preços), Kabum no transformer (RF-032).

## 7. Matriz de cobertura RF → US

| RF | Status SRS | US que cobre |
| --- | --- | --- |
| RF-001 | Removido | `REMOVIDO` (não vira US) |
| RF-002 | Implementado parcial | US-45 |
| RF-003 | Implementado | US-01..09 |
| RF-004 | Implementado | US-01..09 |
| RF-005 | Adiado | US-41 |
| RF-006 | Implementado | US-01..09 |
| RF-007 | Histórico/Parcial | US-43 |
| RF-008 | Parcial/legado | US-49 |
| RF-009 | Implementado parcial | US-48 |
| RF-010 | Implementado | US-01..09 |
| RF-011 | Implementado parcial | US-47 |
| RF-012 | Adiado | US-40 |
| RF-013 | Implementado parcial | US-44 |
| RF-014 | Removido | `REMOVIDO` (não vira US) |
| RF-015 | Implementado | US-10 |
| RF-016 | Implementado parcial | US-46 |
| RF-017 | Implementado | US-11 |
| RF-018 | Parcial/legado | US-12 |
| RF-019 | Implementado | US-13 |
| RF-020 | Implementado parcial | US-12 |
| RF-021 | Adiado | US-42 |
| RF-022 | Implementado | US-14 |
| RF-023 | Implementado | US-15 |
| RF-030 | Implementado | US-16 |
| RF-031 | Implementado | US-17 |
| RF-032 | Implementado parcial | US-18 |
| RF-033 | Implementado | US-19 |
| RF-034 | Implementado | US-19 |
| RF-035 | Implementado | US-20 |
| RF-036 | Implementado | US-22 |
| RF-037 | Implementado | US-38 |
| RF-040 | Implementado | US-21 |
| RF-041 | Implementado | US-23 |
| RF-042 | Implementado | US-27 |
| RF-043 | Implementado | US-37 |
| RF-044 | Não implementado | US-39 |
| RF-045 | Implementado | US-24 |
| RF-046 | Implementado | US-25 |
| RF-047 | Implementado | US-26 |
| RF-048 | Implementado | US-30 |
| RF-049 | Implementado | US-31 |
| RF-050 | Implementado | US-32 |
| RF-051 | Implementado | US-33 |
| RF-052 | Implementado | US-34 |
| RF-053 | Implementado | US-35 |
| RF-054 | Implementado | US-28 |
| RF-055 | Implementado | US-29 |
| RF-056 | Implementado | US-36 |

Todos os RF do SRS v0.4 estão cobertos (RF-001 e RF-014 são `REMOVIDO` por decisão do SRS §1.5).

## 8. Riscos de sprint

| Risco | Prob. | Impacto | Mitigação |
| --- | --- | --- | --- |
| Bloqueio de número por volume | Média | Alto | Manter rotação (US-27) e filas (US-25/US-37); não reintroduzir envio em rajada |
| Rate-limit da Evolution no sync | Alta | Médio | Pausas/backoff já implementados (US-24/US-36); monitorar aba Monitor |
| Mudança de contrato da Evolution/ML/Shopee | Média | Alto | Módulos inertes sem credencial; falha vai para revisão, nunca inventa link |
| Docs voltarem a defasar | Alta | Médio | Entrada no `dev-log.md` como item de DoD (todo PR) |
| Exposição de PII em docs/logs | Baixa | Alto | Placeholders; IP `/24`; revisão antes de push |

## 9. Issues e milestones sugeridos

- Meses/Épicos já entregues: issues **#9–#28** (não reaproveitar números).
- Abrir issues para E13: `US-39 efêmeras`, `US-43 preview fiel`, `US-44 observabilidade`;
  `US-40/US-41/US-42` como backlog com label `adiado`.
- Milestones sugeridos: `MONITOR-MVP` (fechado), `AUTH-CLIENTES-NUMEROS` (fechado, E7–E12),
  `DOCS-v0.4` (em curso), `E13-EVOLUCAO` (futuro).
