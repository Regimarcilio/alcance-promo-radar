# Alcance

Monitor de ofertas para WhatsApp: recebe mensagens de grupos de afiliados, identifica o produto
(Mercado Livre, Amazon, Shopee), troca o link pelo seu link de afiliado e reencaminha para os seus
grupos — com fila anti-rajada, dedup, rotação de números e painel web autenticado.

> Nome técnico legado do pacote: `automensagemwhats`. O produto e a interface usam a marca **Alcance**.

## O que faz

- **Monitor**: webhook da Evolution API → parser → transformação de link → template Emipe → envio.
- **Multi-programa**: Mercado Livre (`meli.la`), Amazon (`amzn.to`/ASIN) e Shopee (`shope.ee`).
- **Multi-número**: rotação ponderada, limite diário, janela 8h–22h e jitter humano.
- **Clientes**: sincroniza participantes dos grupos, mantém listas e dispara campanhas.
- **Painel**: piloto automático, monitor, clientes, contas, cupons e números, com 6 temas.
- **Segurança**: login com sessão, default-deny, rate-limit, auditoria e headers restritivos.

## Stack

Node.js ≥ 20 · TypeScript ESM · Evolution API v2 (Baileys) · Docker Compose · estado em JSON (`data/`).

## Quickstart

```bash
npm ci
cp .env.example .env         # preencha EVO_KEY, SESSION_SECRET, WEBHOOK_KEY etc.
npm run auth:user -- admin   # cria a credencial do painel (prompt oculto)
npm run build
npm run manager              # http://localhost:8091
```

Para desenvolvimento com recarga:

```bash
npm run manager:dev
```

## Docker

```bash
docker compose -f docker-compose.manager-novo.yml up -d --build
# painel em http://127.0.0.1:8099
```

O compose publica a porta apenas em **loopback**. Para acessar de outra máquina, configure
TLS/reverse proxy antes — veja `docs/13-auth-spec.md`.

## Variáveis essenciais

| Variável | Para que serve |
|---|---|
| `EVO_URL`, `EVO_KEY`, `EVO_INSTANCE` | conexão com a Evolution API |
| `WEBHOOK_KEY` | autentica o webhook (`X-Webhook-Key`, mínimo 16 chars) |
| `SESSION_SECRET` | assina a sessão do painel (mínimo 32 chars) |
| `AUTH_TTL_HORAS`, `AUTH_IDLE_MIN` | validade absoluta e por inatividade da sessão |
| `MANAGER_KEY` | credencial machine opcional para `/api/*` |
| `AMAZON_TAG`, `AMAZON_CREATORS_ID`, `AMAZON_CREATORS_SECRET` | Amazon |
| `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET`, `SHOPEE_SUB_IDS` | link curto de afiliado Shopee via Open API (`generateShortLink`) |
| `TAG_ML`, `COOKIE_ML` | enriquecimento Mercado Livre |

O template completo está em `.env.example`.

## Testes e qualidade

```bash
npm run typecheck
npm run build
npm test                 # 22 testes (node:test)
npm run smoke:manager    # sobe o manager com estado temporário e valida o gate
```

O CI roda typecheck, build, testes, smoke do manager e smoke do CLI em todo push/PR.

## Estrutura

```
src/manager/    painel (HTTP), autenticação e login
src/monitor/    webhook, parser, transformação, fila, dedup
src/wa/         dispatch, providers Evolution e rotação de números
src/clientes/   contatos, listas e campanhas
src/ml/         motor de ofertas Mercado Livre
src/hunter/     busca por categoria/palavra-chave
src/jobs/       execução automática
docs/           SRS, arquitetura, ADRs, backlog e diário de bordo
```

## Documentação

- `docs/14-relatorio-geral.md` — estado atual, riscos e roadmap.
- `docs/SRS.md` — requisitos (v0.3; v0.4 em planejamento).
- `docs/03-arquitetura-e-uml.md` — arquitetura e diagramas.
- `docs/04-ADRs/` — decisões arquiteturais.
- `docs/05-backlog.md` — épicos e user stories.
- `docs/13-auth-spec.md` — autenticação e checklist de segurança.
- `docs/15-plano-sincronizacao-docs.md` — plano de atualização da documentação.
- `docs/dev-log.md` — diário de bordo com evidências por entrega.

## Segurança

- Credenciais nunca vão para o repositório; `.env`, `data/` e `logs/` são ignorados.
- A senha do painel fica em `data/auth-users.json` (modo 0600), criada por `npm run auth:user`.
- O webhook exige `WEBHOOK_KEY`; o painel exige sessão (ou `MANAGER_KEY` para machine).
- **Não exponha em LAN/WAN sem TLS.** O compose atual publica só em `127.0.0.1`.

## Licença

Uso privado. Consulte o responsável pelo projeto antes de redistribuir.
