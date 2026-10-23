# Alcance

Monitor de ofertas para WhatsApp: recebe mensagens de grupos de afiliados, identifica o produto
(Mercado Livre, Amazon, Shopee), troca o link pelo seu link de afiliado e reencaminha para os seus
grupos — com fila anti-rajada, dedup, rotação de números e painel web autenticado.

> Nome técnico legado do pacote: `automensagemwhats`. O produto e a interface usam a marca **Alcance**.

## O que faz

- **Monitor**: webhook da Evolution API → parser → transformação de link → template Emipe → envio.
- **Multi-programa**: Mercado Livre (`meli.la`), Amazon (`amzn.to`/ASIN) e Shopee (`shope.ee`).
- **Multi-número**: rotação ponderada entre até 5 números; todos os abertos (principal inclusive) enviam, na proporção do peso; principal preferido para serviços; janela de envio 8h–23h (`JANELA_INICIO`/`JANELA_FIM`, padrão `23`) e **sem limite diário**.
- **Clientes**: sincroniza participantes dos grupos, mantém listas e dispara campanhas.
- **Painel**: piloto automático, monitor, clientes, contas, cupons, números e rastreio, com 6 temas.
- **Segurança**: login com sessão, default-deny, rate-limit, verificação de celular por WhatsApp no 1º acesso, auditoria e headers restritivos.

## Stack

Node.js ≥ 20 · TypeScript ESM · Evolution API v2 (Baileys) · Docker Compose · persistência em JSON (`data/`).

**Persistência:** o projeto **não usa SQLite** (nem outro banco próprio). Todo o estado operacional é gravado em arquivos JSON atômicos dentro de `data/` — por exemplo `auth-users.json`, `clientes.json`, `instancias.json`, `monitor.json`, `monitor-estado.json`, `monitor-fila.json`, `envios.json` e `publicacoes.json`. O Postgres do `docker-compose.yml` pertence **apenas à Evolution API v2**, não ao Alcance.

## Quickstart

```bash
npm ci
cp .env.example .env         # preencha EVO_KEY, SESSION_SECRET, WEBHOOK_KEY etc.
npm run auth:user -- admin --telefone 5511999999999
npm run build
npm run manager              # http://localhost:8091
```

O `auth:user` **exige o celular** (`--telefone`, com DDI) e cria a credencial em
`data/auth-users.json` com modo `0600`. No primeiro login o painel pede um código alfanumérico de
10 posições enviado por WhatsApp; o código expira em 10 minutos.

> **A Evolution precisa estar no ar** (`EVO_URL`/`EVO_KEY` válidos) para o envio do código de
> verificação. Se ela estiver fora, o usuário é criado mesmo assim, mas o celular fica pendente e o
> primeiro login não conclui até a confirmação. Reexecute o comando quando a Evolution estiver
> disponível. Em ambiente sem TTY (CI), use `AUTH_PASSWORD='...' npm run auth:user -- admin --telefone 5511999999999`.

Para desenvolvimento com recarga:

```bash
npm run manager:dev
```

## Docker

Há dois caminhos — escolha conforme o ambiente:

**1. Stack completa (recomendado para subir do zero).** O `docker-compose.yml` é o único compose
que tem `build:`. Ele constrói a imagem do manager a partir de `Dockerfile.manager` (imagem
resultante: `automensagemwhats-manager:latest`) e sobe Evolution v2 + Postgres:

```bash
docker compose up -d --build
# painel em http://127.0.0.1:${MANAGER_PORT:-8091}/login
```

Esse compose publica a porta em **loopback por padrão** (`${MANAGER_BIND:-127.0.0.1}:${MANAGER_PORT:-8091}`).
Para expor em LAN/WAN, use TLS/reverse proxy e só então `MANAGER_BIND=0.0.0.0`. Para testar em HTTP
local, ajuste também `AUTH_COOKIE_SECURE=0` no `.env`; em produção o cookie exige HTTPS.

**2. Somente o manager, na rede da Evolution existente.** O `docker-compose.manager-novo.yml`
**não tem `build:`**: ele consome a imagem pronta `promo-radar-manager:latest`, publica apenas em
`127.0.0.1:${MANAGER_PORT_NOVO:-8099}` e usa a rede externa `automensagemwhats_default` (com a
Evolution atendendo pelo hostname `evolution`). Como essa imagem não é construída por nenhum compose
do repositório, construa-a antes:

```bash
docker build -f Dockerfile.manager -t promo-radar-manager:latest .
docker compose -f docker-compose.manager-novo.yml up -d
# painel em http://127.0.0.1:8099
```

Não use `--build` com `docker-compose.manager-novo.yml` esperando que ele construa a imagem: o
arquivo só declara `image:`. A rede externa precisa existir; se o projeto antigo não estiver no ar,
crie/substitua a rede conscientemente antes de subir esse compose.

O compose `manager-novo` publica a porta apenas em **loopback**. Para acessar de outra máquina,
configure TLS/reverse proxy antes — veja `docs/13-auth-spec.md`.

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
| `MONITOR_EVENTOS_LIMITE` | quantos eventos o estado do monitor guarda (`0` = ilimitado, padrão `500`) |
| `TAG_ML`, `COOKIE_ML` | enriquecimento Mercado Livre |
| `ML_ACCESS_TOKEN` | access token OAuth do ML (favoritar itens automaticamente) |

O template completo está em `.env.example`.

## Testes e qualidade

```bash
npm run typecheck
npm run build
npm test                 # 118 testes em 21 arquivos (node:test)
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

- `docs/00-INDICE.md` — índice geral, versões e status (vigente/histórico/planejado).
- `docs/SRS-v0.4.md` — requisitos vigentes (v0.4), rastreabilidade RF → código → teste.
- `docs/14-relatorio-geral.md` — **retrato histórico** de 2026-10-21 (não é a fonte de verdade atual).
- `docs/03-arquitetura-e-uml.md` — arquitetura e diagramas (v0.1/v0.2; leia junto do SRS v0.4).
- `docs/04-ADRs/` — decisões arquiteturais (ADRs 001–010).
- `docs/05-backlog.md` — épicos e user stories (v0.3; backlog v0.4 pendente).
- `docs/11-padrao-emipe.md` — template de mensagem vigente (RN-001 v3).
- `docs/13-auth-spec.md` — autenticação e checklist de segurança.
- `docs/15-plano-sincronizacao-docs.md` — plano de atualização e status desta rodada.
- `docs/dev-log.md` — diário de bordo com evidências por entrega.
- `CHANGELOG.md` — release notes (Keep a Changelog).

## Segurança

- Credenciais nunca vão para o repositório; `.env`, `data/` e `logs/` são ignorados.
- A senha do painel fica em `data/auth-users.json` (modo 0600), criada por `npm run auth:user`.
- O webhook exige `WEBHOOK_KEY`; o painel exige sessão (ou `MANAGER_KEY` para machine).
- **Não exponha em LAN/WAN sem TLS.** O `docker-compose.manager-novo.yml` publica só em
  `127.0.0.1`; o `docker-compose.yml` publica `${MANAGER_PORT:-8091}` em todas as interfaces e exige
  firewall/reverse proxy consciente.

## Licença

Uso privado. Consulte o responsável pelo projeto antes de redistribuir.
