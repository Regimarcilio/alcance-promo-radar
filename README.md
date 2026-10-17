# autoMensagemWhats 🤖📲

Caçador autônomo de ofertas do Mercado Livre **por categoria + palavra-chave opcional**, com geração de mensagem no padrão WhatsApp e envio ao grupo — tudo automático.

- **Entrada:** lista suspensa de categorias ([mercadolivre.com.br/categorias](https://www.mercadolivre.com.br/categorias)) + keyword opcional (vazio = categoria inteira).
- **Busca:** `GET /sites/MLB/search?category=ID[&q=...]` (com fallback MOCK no piloto).
- **Saída:** mensagem RN-001 (negrito/itálico/riscado + cupom + `meli.la`) + envio Evolution/Cloud.
- **Protótipo visual:** abra `docs/prototipo/index.html`.
- **Planejamento:** `docs/01-visao-e-escopo.md`, `docs/SRS.md`, `docs/02-benchmarks.md`, `docs/03-arquitetura-e-uml.md`, `docs/05-backlog.md`.

## Quickstart

```bash
nvm use 20 2>/dev/null; npm install
cp .env.example .env  # preencher TAG_ML/COOKIE_ML/EVO_*
npm run build

# categorias oficiais
node dist/cli.js categorias:list

# caçar em toda a categoria (sem keyword)
node dist/cli.js hunter:buscar --category MLB3937 --limite 3

# caçar categoria + palavra-chave
node dist/cli.js hunter:buscar --category MLB3937 --q "Orient" --limite 3

# simular envio (dry-run, não manda nada)
node dist/cli.js hunter:buscar --category MLB3937 --q "Orient" --limite 3 --enviar --dry-run

# passada automática (cron): REVISÃO enfilera, AUTO (MODO=AUTO + AUTO_APROVADO=true) envia
node dist/cli.js hunter:auto --category MLB3937 --q "Orient" --corte 75
node dist/cli.js fila:list
node dist/cli.js fila:approve MLB-4210056475   # adicione --live para enviar de verdade
```

## Gerenciador web (tela — recomendado)

```bash
npm run manager          # sobe em http://localhost:8091
# na rede local: http://SEU-IP:8091 (ex.: http://192.168.0.108:8091)
```

Na tela: escolha a **categoria** (31 oficiais) + **palavra-chave opcional** → **Buscar** → cards com foto, preço, score e selo → **Enviar no WhatsApp** (pede confirmação) → volta **messageId + link + prévia da mensagem**. Selo DEMO = busca ML bloqueada nesta rede (MOCK); LIVE = dados reais.

## Automático (cron, a cada 2h na janela 8h–22h)

```bash
0 8,10,12,14,16,18,20,22 * * * cd /home/oficina/PROJETOS/autoMensagemWhats && npm start -- hunter:auto --category MLB3937 --corte 75 --live >> data/cron.log 2>&1
```

Kill-switch imediato: `touch data/AUTO_OFF` (para) / `rm data/AUTO_OFF` (retoma). Limite diário via `LIMITE_DIA` no `.env`. Enrich real do link afiliado: preencher `TAG_ML`, `COOKIE_ML` e opcional `ML_CONVERSOR_URL`.

## Produção (piloto seguro)

1. `docker compose up -d` (Evolution v2) + parear QR (`npm run dev -- evo:qr`).
2. Preencher `.env` (`EVO_URL`, `EVO_KEY`, `GRUPO_TESTE`, `AUTO_APROVADO=false` + modo `REVISAO` na 1ª semana).
3. Ritmo: ≤10 msgs/dia/nº, janela 8h–22h, 1 IP BR por número.

## Engine alternativo: Evolution GO

A GO (Go, alta performance) exige PostgreSQL e tem QR em endpoint próprio
(`GET /instance/{nome}/qrcode`). Passos:

```bash
docker compose -f docker-compose.go.yml up -d   # GO na 8081 + postgres
# .env: EVO_ENGINE=go, EVO_GO_URL=http://localhost:8081, EVO_GO_KEY=<forte>
curl -X POST http://localhost:8081/instance/create \
  -H "Content-Type: application/json" -H "apikey: $EVO_GO_KEY" \
  -d '{"instanceName":"radar-piloto","integration":"WHATSAPP-BAILEYS"}'
npm run dev -- evo:qr --save qr-go.png   # escanear em <60s
npm run dev -- evo:status                # connected=true = pareado
```

O dispatch roteia sozinho via `EVO_ENGINE=v2|go`. Se o envio na GO der 404,
confirme o path no Swagger (`EVO_GO_URL/swagger/index.html`) e ajuste
`EVO_GO_SEND_PATH`. Piloto segue na **v2** (mais simples, sem banco).

## Scripts

| script | o que faz |
|---|---|
| `npm run dev` | roda CLI via tsx (dev) |
| `npm run build` | compila para `dist/` |
| `npm run typecheck` | valida tipos sem emitir |
| `npm start` | roda CLI compilado |

## Estrutura

```
src/categorias.json   # 31 categorias (cache; runtime resolve via /sites/MLB/categories)
src/hunter/           # schema (filtros + buildSearchUrl) + service (search Top50)
src/scorer.ts         # score explicável + selo QUEDA REAL/OFERTA BOA
src/wa/formatter.ts   # template RN-001 (única fonte do formato)
src/wa/dispatch.ts    # roteia v2 ↔ GO via EVO_ENGINE (Cloud futuro)
src/wa/evolution-go.ts # provider GO: QR /instance/{nome}/qrcode + status + envio
src/store/dedup.ts    # anti-duplicidade 7d
src/cli.ts            # categorias:list | hunter:buscar
docs/prototipo/       # protótipo HTML do fluxo
data/envios.json      # log local de envios (git-ignored)
```
