# 14 — Relatório Geral do Projeto — Alcance (`promo-radar-novo`)

> Levantamento: 2026-10-21 · Branch `develop` @ `639d92f` · Árvore limpa
> Método: inspeção de código, documentação, Git, runtime (containers/HTTP/logs) e execução de build/testes.
> Este relatório é um retrato do estado real; nenhuma funcionalidade foi alterada para produzi-lo.

---

## 1. Veredito executivo

**Nota geral: 7,5/10** — produto operacional, autenticado e com testes reais; ainda frágil em backup remoto, documentação viva e isolamento de infraestrutura.

Evolução em relação à auditoria de 2026-10-19 (nota 6,5):

| Dimensão | Nota | Situação |
|---|---:|---|
| Arquitetura / organização | 7,0 | Módulos coesos; `server.ts` ainda é monólito de 2.145 linhas |
| Docs × entrega | 5,0 | SRS/backlog/README pararam em v0.3 (2026-10-17) |
| Qualidade de código | 6,5 | Typecheck limpo; duplicações e dívidas conhecidas |
| Testes | 6,0 | **22/22 passando** (era 0), cobertura parcial |
| Git / versionamento | 6,5 | Commits bons; sem remoto e sem tags até esta publicação |
| Operação / deploy | 8,0 | Container saudável, legado eliminado, auth ativo |
| Segurança | 7,5 | Auth sólida; falta TLS, non-root e CSP sem `unsafe-inline` |
| Observabilidade | 6,0 | Logs e contadores; sem métricas/alertas |

**Melhorias desde a auditoria:** container legado `automensagem_manager` removido (A1 fechado); 22 testes automatizados (A3 parcial); login real com sessão/default-deny em produção (E6-AUTH-02).

**Riscos que permanecem:** ausência de remote Git (A2, fechado com a publicação), documentação principal defasada (A4) e CI que não executava os testes (M5).

---

## 2. Identificação e stack

| Item | Valor |
|---|---|
| Produto | **Alcance** (nome técnico legado: `automensagemwhats`) |
| Versão no `package.json` | `0.8.0` |
| Stack | Node.js ≥20, TypeScript 5.6 ESM (`NodeNext`), `tsx`, `zod`, `dotenv` |
| Persistência | JSON em `data/` (sem banco próprio) |
| WhatsApp | Evolution API v2.3.7 (Baileys) + provider GO alternativo |
| Frontend | HTML/CSS/JS inline servido por `src/manager/server.ts` |
| Deploy | Docker Compose + imagem `promo-radar-manager:latest` |
| Porta | `127.0.0.1:8099` → container `8091` |
| Código | 42 arquivos em `src/` · 40 `.ts` · **7.968 LOC TS** · 8.777 LOC totais |
| Docs | 31 arquivos · 1,9 MB |
| Dados | 85 MB (`data/`), dos quais 84 MB são mídia |

---

## 3. Estado do Git

| Verificação | Resultado |
|---|---|
| Branch ativa | `develop` |
| Árvore de trabalho | limpa |
| Commits | 40 |
| `develop` à frente de `master` | **39 commits** (master parado no commit inicial `ae336b6`) |
| Remote | ausente antes desta publicação |
| Tags / releases | nenhuma |
| Stash | vazio |
| Autor | único (`Oficina Teste`) |
| Segredos versionados | nenhum (`.env`, `data/`, `logs/` ignorados) |

---

## 4. Arquitetura e módulos

### 4.1 Mapa de módulos

| Domínio | Arquivos | Responsabilidade |
|---|---|---|
| `src/manager/` | `server.ts` (2.145 L), `auth.ts` (432), `login.html`, `auth.test.ts` | UI+API, sessão, gate, webhook |
| `src/monitor/` | webhook, parser, transformer, produto, curtos, amazon-api, grupos, fila, state, midia, evolution | Recebe ofertas, identifica programa, transforma link, encaminha |
| `src/wa/` | dispatch, evolution-go, formatter, rotacao | Envio multi-provider e multi-número |
| `src/ml/` | piloto (673), hub, vitrine, cupons, contas, affiliate, provider | Motor de ofertas ML/Afilimax |
| `src/clientes/` | clientes.ts (380) | Sync de contatos/grupos e disparo individual |
| `src/hunter/` | schema, service | Busca por categoria/palavra-chave |
| `src/store/` | dedup.ts | Anti-duplicidade 7 dias |
| `src/jobs/` | auto.ts | Passada automática |
| `src/ai/` | gateway.ts (37 L) | Stub de gateway IA |
| `src/ui/` | titulos.ts | Títulos editáveis dos cards |

### 4.2 Pontos arquiteturais

- **Monólito de UI/API:** `server.ts` concentra ~52 rotas + mais de 900 linhas de HTML/CSS/JS inline. É a origem histórica dos incidentes de escape; a CSP precisa de `unsafe-inline` por causa dos `onclick` concatenados.
- **Duas filas independentes:** `monitor/fila.ts` e `clientes/clientes.ts` reimplementam o mesmo padrão (worker por tick + JSON + intervalo).
- **Dedup sem poda:** 980 hashes em `monitor-estado.json`, sem remoção automática por idade.
- **Sem handlers globais:** não há `uncaughtException`, `unhandledRejection`, `SIGTERM`/`SIGINT`.
- **Fronteira de produto não declarada:** `src/hunter`, `src/ml`, `src/jobs` são o produto antigo de afiliados; o Alcance usa parte deles.

---

## 5. Funcionalidades entregues

### 5.1 Monitor de ofertas
- Webhook Evolution de grupos monitorados.
- Identificação de Mercado Livre, Amazon, Shopee e links próprios de origem (ex.: Epipe).
- Expansão de `meli.la`/`amzn.to`, resolução de ASIN/MLB e aplicação de tag de afiliado.
- Amazon com foto via CDN por ASIN e client Creators API (título/foto) com fallback.
- Template Emipe (RN-001), envio de mídia/texto e registro de `messageId`.
- Anti-loop por origem + dedup de 7 dias + fila de revisão.
- Mensagens temporárias de 7 dias no grupo destino (`ephemeralMessage`).
- Grupos com título editável, foto e status por origem/destino.

### 5.2 Operação multi-número
- Duas instâncias ativas: `radar-piloto` (449 envios) e `radar-mano-da-divulgacao-cfb` (202 envios).
- Rotação ponderada, limite diário, janela 8h–22h e jitter humano.
- QR code, ativação/peso/remoção por instância na UI.

### 5.3 Clientes
- 6.147 contatos sincronizados, 1 lista.
- Sync de grupos/participantes, renomear, remover, disparo individual e fila.

### 5.4 Painel
- 6 views: piloto, monitor, clientes, contas, cupons, números.
- 6 temas (verde, laranja, areia, grafite, marrom, cacau) com persistência e fundo dos cards tingido.
- Sidebar com links dinâmicos e títulos editáveis.

### 5.5 Autenticação (E6-AUTH-02)
- Login real (opção 1 — Sala de controle), scrypt assíncrono e `timingSafeEqual`.
- Sessão `alcance_sid` HttpOnly/SameSite=Strict, 8h absoluta + 30min idle.
- Default-deny em `GET /` e `/api/*`; webhook isento por chave.
- Rate-limit 5/min por IP + 30/min global; auditoria JSONL com IP /24.
- `MANAGER_KEY` apenas como credencial machine; removida do `sessionStorage`.

---

## 6. Runtime e produção

| Container | Imagem | Status | Porta |
|---|---|---|---|
| `promo_radar_manager` | `promo-radar-manager:latest` | Up 3h | `127.0.0.1:8099→8091` |
| `evolution_api_radar` | `evoapicloud/evolution-api:v2.3.7` | Up 8 dias | `8082→8080` |
| `evolution_pg_radar` | `postgres:16-alpine` | Up 8 dias | interna |
| Legado `automensagem_manager` | — | removido | — |

Verificações ao vivo:
- `GET /login` → **200**
- `GET /` sem sessão → **302** (gate funcionando)
- 2 ocorrências de `[dispatch] erro transitório (Evolution sendMedia 500)` nas últimas 24h — retry automático ativo, sem falha persistente.
- Container roda como **root** (`Config.User` vazio), `restart: unless-stopped`.

---

## 7. Dados operacionais

| Arquivo | Conteúdo |
|---|---|
| `data/clientes.json` | 1,2 MB · **6.147 contatos** · 1 lista |
| `data/monitor-estado.json` | 212 KB · **980 hashes** · 500 eventos |
| `data/envios.json` | 40 KB · 283 envios deduplicados |
| `data/instancias.json` | 2 instâncias · 651 envios acumulados |
| `data/midia/` | **475 arquivos · 84 MB** (retenção 3 dias) |
| `data/monitor.json` | configuração de grupos (600 root — ilegível no host) |
| `data/auth-audit.log` | 4 KB · login recente registrado |
| `data/debug-webhook.log` | 258 KB · resíduo do modo debug |

**Eventos do monitor (500 registros):**

| Status | Qtd |
|---|---:|
| ENCAMINHADA | 201 |
| DUPLICADO | 184 |
| REVISAO | 102 |
| ENFILEIRADA | 13 |

| Programa | Qtd |
|---|---:|
| Mercado Livre | 373 |
| Desconhecido | 88 |
| Amazon | 27 |
| Shopee | 12 |

**Problema M1 confirmado:** quase todo `data/` pertence a `root:root`; o usuário do host não consegue ler `monitor.json` (600). Só `auth-users.json` e `auth-audit.log` são `oficina:oficina`.

---

## 8. Qualidade e testes

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run build` | exit 0 |
| `npm test` | **22/22** em 3,7 s |
| Arquivos de teste | 4: `auth.test.ts` (7), `parser.test.ts`, `amazon-api.test.ts`, `curtos.test.ts` |
| Cobertura | Parcial — funções puras e auth; sem testes de fila, rotação, clientes, UI e webhook ponta a ponta |
| CI | typecheck + build + smoke do CLI antigo; **não executava `npm test`** antes desta entrega |
| Dependências | `pino` declarada e nunca importada; `zod` usada só em `hunter/schema.ts` |

---

## 9. Documentação e rastreabilidade

| Documento | Estado |
|---|---|
| `docs/SRS.md` | v0.3 (2026-10-17) · 22 RFs · 8 NFRs · 13 RNs |
| `docs/05-backlog.md` | v0.3 · US-01 a US-20 · 8 sprints planejadas |
| `docs/01-visao-e-escopo.md` | v0.2 (nome antigo) |
| `docs/03-arquitetura-e-uml.md` | v0.1 + delta v0.2 |
| `docs/04-ADRs/` | 4 ADRs (envio, IA, fonte ML, hunter) |
| `docs/dev-log.md` | Excelente, com evidência por entrega |
| `README.md` | ainda “autoMensagemWhats”, porta 8091, sem auth/monitor/clientes |
| `docs/13-auth-spec.md` | atualizado com a implementação |

**Lacunas de rastreabilidade:** zero menções no SRS/backlog a multi-número, clientes, `ephemeralMessage`, login/auth e rotação. Não há ADRs 005–008 para rotação multi-número, fila só-pra-rajada, fonte de contatos e temas/títulos.

Plano de correção: `docs/15-plano-sincronizacao-docs.md`.

---

## 10. Segurança

**Implementado e verificado:**
- Senha com scrypt (`N=2^15`), salt 16B e comparação timing-safe.
- Sessão assinada com HMAC, TTL absoluto/idle, limite de 5 sessões e sweeper.
- Default-deny, Origin/`Sec-Fetch-Site`, body limit, headers CSP/COOP/CORP/nosniff/frame-deny.
- Rate-limit de login e auditoria sem PII.
- `.env` fora do git e da imagem; porta publicada apenas em loopback.
- Nenhum segredo versionado.

**Pendências:**

| Item | Severidade |
|---|---|
| Sem TLS/reverse proxy (obrigatório antes de LAN) | Alta |
| Container e `data/` como root | Média |
| CSP com `unsafe-inline` + `onclick` concatenado | Média |
| XSS latente em `server.ts:1578` (`c.nome` em `innerHTML` e `onclick`) | Média |
| Webhook sem rate-limit dedicado | Média |
| Sem rotação/retenção de `auth-audit.log` | Baixa |
| Sessões em memória (restart desloga todos) | Baixa |

---

## 11. Riscos e achados priorizados

### P0 — agora
1. **Criar repositório remoto privado/público e enviar `develop`** — único backup do projeto.
2. **Colocar `npm test` no CI** e adicionar smoke do manager (`/login` 200, `/` 302).
3. **Definir TLS/reverse proxy** antes de qualquer acesso fora de `127.0.0.1`.

### P1 — próximo ciclo
4. **Sincronizar documentação:** README (marca Alcance, 8099, auth, monitor, clientes), SRS v0.4 e backlog com E6-AUTH/UI/MONITOR-13+; ADRs 005–008.
5. **Corrigir ownership:** `user: "${UID}:${GID}"` no compose + `chown` do `data/`.
6. **Poda do dedup** por idade de 7 dias no carregamento.
7. **Extrair a UI** de `server.ts` para `src/manager/ui/` (template + JS), eliminando a classe de bugs de escape e permitindo CSP sem `unsafe-inline`.

### P2 — backlog técnico
8. Unificar filas em `src/lib/fila.ts`.
9. Handlers globais de erro e shutdown (`SIGTERM`).
10. Alinhar API (`origens`/`destinos` como listas), remover `pino`, documentar as 8 envs restantes, apagar `debug-webhook.log`, criar CHANGELOG.
11. Ampliar testes para fila, rotação, clientes e fluxo webhook→envio.

---

## 12. Pendências que dependem de decisão/credencial do usuário

| Pendência | Impacto |
|---|---|
| Credenciais Amazon Creators API | Título/foto via API (hoje fallback por CDN/ASIN) |
| `SHOPEE_SUBID` | Conversão de links Shopee |
| Rotação das sessões ML | Enriquecimento ML sem cookie expirado |
| TLS/reverse proxy (Caddy/Traefik/Nginx) | Liberar acesso em LAN com segurança |
| Migração do container para non-root | Fechar M1 |

---

## 13. Comandos de verificação

```bash
git status && git branch -vv && git remote -v
npm run typecheck && npm run build && npm test
npm run smoke:manager
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/login   # 200
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/        # 302
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs promo_radar_manager --since 24h | grep -c '\[dispatch\] erro'
```

---

## 14. Conclusão

O **Alcance** saiu de “protótipo operacional sem testes” para **produto autenticado, com 22 testes verdes, duas instâncias de WhatsApp ativas, 201 ofertas encaminhadas e 6.147 contatos sincronizados**. O núcleo funcional está entregue e roda.

O que separa o projeto de um estado “SaaS confiável” não é código novo: é **backup remoto, CI que testa o que importa, documentação que descreve o que existe e infraestrutura que não roda como root**. Resolver os três P0 e os quatro P1 eleva a consistência para ~8,5 sem tocar em nenhuma funcionalidade.

---

## 15. Nota de publicação

Para a publicação em repositório público, o histórico foi sanitizado: telefones, JIDs de grupos e convites do WhatsApp foram substituídos por placeholders, e a pasta `docs/prints/` (capturas com dados reais de conta/grupo) foi removida do histórico público. O diário de bordo e os documentos técnicos foram preservados. Nenhum segredo de `.env` ou arquivo de `data/` estava versionado.
