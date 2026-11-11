# 12 — Auditoria de Consistência — promo-radar-novo / **Alcance**

> **RETRATO HISTÓRICO — 2026-10-19 (commit `74254c2`).**
> Este documento foi preservado como evidência da auditoria daquele dia. Ele **não** descreve o
> estado atual: na época havia zero testes, nenhum remoto Git e documentação parada na v0.3. Desde
> então foram adicionados 99 testes em 17 arquivos, o remoto `github.com/Regimarcilio/alcance-promo-radar`
> e a documentação vigente passou a ser o `docs/SRS-v0.4.md`. Para o estado atual, use
> `docs/00-INDICE.md`, `docs/SRS-v0.4.md` e `CHANGELOG.md`. O conteúdo abaixo **não foi reescrito**.

**Data:** 2026-10-19 · **Branco:** `develop` @ `74254c2` · **Auditor:** planmaster
**Método:** inspeção do código (`src/`, 6.374 LOC em 30 módulos), docs (`docs/`), dados (`data/`),
git, CI e runtime (containers, endpoints, logs) — sem alterar nada.

---

## 1. Veredito geral

**Nota: 6,5/10 — operacionalmente sólido, documentalmente defasado, tecnicamente frágil nos
pontos estruturais.**

O produto **funciona de ponta a ponta** (piloto automático, monitor multi-grupo, multi-número,
clientes, 4 temas) e o diário de bordo é de nível profissional. O que separa isso de um produto
"SaaS" é: **zero testes**, **documentação que não acompanhou a entrega**, **um container legado
disputando a mesma sessão de WhatsApp** e **UI/API monolíticas em um único arquivo**.

| Dimensão | Nota | Comentário curto |
|---|---|---|
| Arquitetura / organização | 7,0 | Bom desenho de módulos; peça central (UI/API) monólito |
| Consistência docs × entrega | 5,0 | SRS/backlog/README/ADRs pararam no v0.3 |
| Qualidade de código | 6,5 | Padrões claros, mas duplicações e pontos frágeis conhecidos |
| Testes / qualidade automatizada | 1,0 | Nenhum teste; `npm test` aponta para o vazio |
| Git / versionamento | 7,0 | Commits bons e limpos; **sem remoto** |
| Operação / deploy | 7,5 | Docker reproducível, health ok; legado em paralelo |
| Segurança / configuração | 7,0 | Segredos fora do git; 1 XSS latente, envs sem doc |
| Observabilidade | 6,0 | Logs por arquivo e contadores; sem métricas/alertas |

---

## 2. Pontos fortes (o que está consistente)

1. **Planejamento rastreável**: `01-visao`, `02-benchmarks`, `SRS` (+delta v0.2), `03-arquitetura`,
   `05-backlog`, `06-plano-de-entrega`, `10-cesta-semente`, `11-padrao-emipe`, 4 ADRs e o
   `dev-log.md` (35 KB) com **prova objetiva por entrega** (saídas de comando, ids de mensagem).
2. **Git disciplinado**: `develop` como tronco, Conventional Commits em pt-BR, árvore limpa,
   `data/`, `logs/` e `.env*` corretamente ignorados — **nenhum segredo versionado**.
3. **Verificação mecânica antes do deploy**: `typecheck` + `node --check` no `<script>` servido
   (rotina criada após o bug de escape) — virou prática desde o incidente `c4515fd`.
4. **Módulos coesos por domínio**: `monitor/` (7 módulos ≤300L), `wa/` (rotação/dispatch), `ml/`,
   `clientes/`, `ui/` — cada arquivo com responsabilidade clara.
5. **Runtime saudável**: `promo_radar_manager` up, **sem erros nos últimos 30 min**, webhook único
   apontando para o container certo (`webhookBase64:true`), dedup ativo (449 hashes),
   retenção de mídia (3 dias, 31 MB) funcionando, logs do piloto rotacionados por dia.
6. **CI existe** (`.github/workflows/ci.yml`): `npm ci` → typecheck → build → smoke do CLI.
7. **Env documentada** em `.env.example` (75 linhas) — 33 de 38 variáveis cobertas.

---

## 3. Achados por severidade

### 🔴 ALTA

**A1 — Container legado operando a MESMA sessão de WhatsApp**
`automensagem_manager` (imagem `automensagemwhats-manager:latest`) está **up há 4 dias**, com
`EVO_INSTANCE=radar-piloto` — a mesma instância do `promo_radar_manager`. Hoje o webhook aponta só
para o novo container, mas o legado ainda expõe UI na **8091** e pode enviar/encerrar sessão.
→ Dois cérebros sobre um número = risco de banimento, mensagem duplicada e estado divergente.

**A2 — Sem remoto Git**
`git remote -v` vazio: 30+ commits e todo o histórico existem **apenas neste disco** (`.git` 4,2 MB).
→ Um `rm` ou falha de disco apaga o projeto e o diário de bordo.

**A3 — Zero testes automatizados**
`package.json` define `"test": "node --test dist/**/*.test.js"`, mas **não existe nenhum
`*.test.ts`** no repositório. O script nunca rodou com sucesso.
→ Regressões só são descobertas em produção (já ocorreu: escape `c4515fd`, Emipe `2791e02`).

**A4 — Documentação principal defasada da entrega**
- `README.md`: ainda se chama **autoMensagemWhats** e instrui `http://localhost:8091` (hoje é
  **Alcance** em **8099**); não menciona monitor, clientes, rotação de números nem temas.
- `docs/SRS.md`: **0 menções** a multi-número, clientes, fila de rajada, `ephemeralMessage` e
  paletas — 6 entregas grandes sem requisito rastreável.
- `docs/05-backlog.md`: v0.3 (E5/E6 até US-20); não há US para E6-MONITOR-13/14/15,
  E6-CLIENTES-01 nem E6-UI-01/02 (registrados só no dev-log).
- `docs/04-ADRs/`: 4 ADRs (envio, IA, fonte ML, hunter) — **nenhum** para as decisões recentes
  (rotação multi-número, fila só-pra-rajada 120 s, sync de contatos via `/group/participants`,
  sistema de temas/títulos).

### 🟡 MÉDIA

**M1 — `data/` pertence ao root**
O container roda como `uid=0`; todos os arquivos de estado nascem `root:root`. O usuário do host
**não consegue editar nada** (já travou duas correções, contornadas via `docker exec`).
→ Solução conhecida: `user: "${UID}:${GID}"` no compose ou `chown` no entrypoint.

**M2 — `src/manager/server.ts` monolítico (1.660 linhas)**
**914 linhas são a UI inteira** (HTML + CSS + JS dentro de um template literal) e 52 rotas
convivem com regra de negócio. Foi a origem dos **dois incidentes de escape** (`\'` e `\n`), porque
`onclick` é montado por concatenação de strings.
→ Extrair view para arquivo(s) próprio(s) elimina a classe inteira de bug.

**M3 — Fila duplicada**
`src/monitor/fila.ts` (192 L) e `src/clientes/clientes.ts` (380 L) reimplementam o **mesmo padrão**:
worker por tick, fila em JSON, intervalo configurável, limpeza de mídia/estado.
→ Dois lugares para corrigir o mesmo bug; candidato a `src/lib/fila.ts` genérico.

**M4 — Dedup sem poda por idade**
`state.ts` verifica "já visto nos últimos 7 dias" (RF-035), mas **nunca remove hashes antigos** —
só o `limparDedup()` manual. `monitor-estado.json` já tem 190 KB / 449 hashes e cresce para sempre
(~1 por mensagem encaminhada).

**M5 — CI testa o produto antigo**
O pipeline valida `cli.js categorias:list` e `hunter:buscar MLB3937` (fluxo do afiliado ML).
Nenhum passo cobre o que é o produto hoje (manager/monitor/clientes). **CI verde ≠ Alcance sadio.**

**M6 — Sem handlers globais de erro/shutdown**
Não há `uncaughtException`, `unhandledRejection` nem `SIGTERM`. Um throw fora de try derruba o
manager sem log de causa; `docker stop` não faz desligamento limpo dos workers.

### 🟢 BAIXA

| # | Achado | Detalhe |
|---|---|---|
| B1 | Dependência fantasma | `pino` declarada e **nunca importada**; `zod` só em `hunter/schema.ts` |
| B2 | Envs sem documentação | `CLIENTES_INTERVALO_S`, `MONITOR_FILA_INTERVALO_S`, `MONITOR_DEBUG`, `MONITOR_DRY`, `WEBHOOK_URL` |
| B3 | Resíduos em `data/` | `debug-webhook.log` (258 KB, do modo debug já removido do compose) |
| B4 | XSS/escape latente | Linha 1128: `c.nome` (texto livre) entra em `innerHTML` **e** em `onclick="tornarPadrao('...')"` sem `esc()` — mesma classe dos incidentes anteriores |
| B5 | API com nomes mistos | `/api/monitor/status` devolve `origens`/`destinos` como **números**; `/api/monitor/grupos` devolve a **lista** em `regras` — mesmo conceito, dois nomes/tipos |
| B6 | Escopo duplo no repo | `src/hunter`, `src/jobs`, `src/ml` (hunt/vitrine/cupons) são o **produto afiliado ML**; o produto atual (`Alcance`) usa parte deles — a fronteira não está declarada em nenhum doc |
| B7 | Permissões inconsistentes | `contas.json` e `monitor.json` em `600`; demais estados em `644` |
| B8 | Sem CHANGELOG | Histórico só no `dev-log.md` (que é excelente, mas não é release notes) |

---

## 4. Evidências coletadas

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | ✅ sem erros |
| `node --check` nos 2 `<script>` servidos | ✅ sintaxe válida |
| `docker ps` | ✅ manager up 27 min · ⚠️ legado up 4 dias |
| Erros no log do manager (30 min) | ✅ nenhum |
| Webhook Evolution | ✅ 1 registro, URL `promo_radar_manager:8091`, `base64:true`, `enabled:true` |
| Dedup | ✅ funcionando (449 hashes; sem poda por idade) |
| Mídia | ✅ 178 arquivos / 31 MB, retenção 3 dias ativa |
| Árvore git | ✅ limpa, `develop`, sem remoto |
| Cobertura de envs | 33/38 no `.env.example` |
| Testes | ❌ 0 arquivos (`npm test` aponta para nada) |
| Tamanho do projeto | `src/` 328 KB · `docs/` 1,7 MB · `data/` 32 MB |

---

## 5. Plano de correção sugerido (prioridade)

**P0 — esta semana**
1. **Encerrar o legado**: `docker stop automensagem_manager && docker rm` (confirmar que nada mais
   depende dele) — elimina A1.
2. **Criar remoto privado** (GitHub/GitLab) e `git push -u origin develop` — elimina A2.
3. **Subir 10–15 testes de fumaça** (`node:test`) nas funções puras que já têm prova manual:
   `normalizarTelefone`, `desembrulhar/extrairMensagem`, `ehRajada`, `transformar`, `rotacao.sorteio`,
   `definirTitulo`. Ligar ao CI — ataca A3 e M5.

**P1 — próximo ciclo**
4. **Sincronizar docs**: README (marca Alcance, 8099, features atuais), SRS v0.3 (multi-número,
   clientes, fila de rajada, ephemeral, temas) e backlog com as US entregues (ou marcar como
   "entregue fora do backlog") — ataca A4.
5. **ADRs 005–008**: rotação multi-número · fila só-pra-rajada · fonte de contatos
   `/group/participants` · temas/títulos por painel.
6. **Poda do dedup** por idade (7 dias) no carregamento + `user:`/`chown` no compose (M4/M1).

**P2 — backlog técnico**
7. Extrair a UI de `server.ts` para `src/manager/ui/` (template + `ui.js`) — M2/B4.
8. Unificar os workers de fila em `src/lib/fila.ts` — M3.
9. Handlers de `uncaughtException`/`unhandledRejection`/`SIGTERM` — M6.
10. Alinhar API (`origens`/`destinos` como listas), remover `pino`, documentar as 5 envs,
    apagar resíduos de `data/` — B1/B2/B3/B5/B7.

---

## 6. Conclusão

O **Alcance** está em estado **operável e auditável** — o que é raro num projeto com 30 tabelas de
estado e integração com WhatsApp. O risco real não está no código que roda, e sim no que **não
existe em volta dele**: backup remoto, testes e documentação viva. Resolver os três P0 desta
auditoria eleva a nota consistência para ~8,5 sem tocar em nenhuma funcionalidade.
