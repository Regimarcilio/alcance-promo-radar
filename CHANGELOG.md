# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento
[SemVer](https://semver.org/lang/pt-BR/). As versões anteriores a 0.8.0 são reconstruídas a partir
do histórico do git (`git log`), sem tags formais.

## [Unreleased]

### Segurança
- Revisão de headers de segurança e endurecimento do gate default-deny do painel.
- **LFI/SSRF em imagem**: `validarImagem()` passou a exigir allowlist de `data/midia`
  (nome UUID + realpath) e bloqueia loopback/privados/credenciais em URL remota.
- **XSS armazenado no painel**: escapes de nome/JID/aviso/título e `linkSeguro()` para href;
  ações de instância migradas para `data-*` (sem interpolar nome em `onclick`).
- **Reenvio de código**: rate-limit de 3/h por IP, resposta uniforme e reenvio não zera o
  lockout de tentativas; cookies `Secure` por padrão em produção.
- **Sessão amarrada** a IP mascarado (/24) + User-Agent; `referrer-policy` e CSP sem `http:`
  em `img-src`.
- **Falha fechada** no dispatch quando `EVO_URL/EVO_KEY` ausentes (fora de dry-run), com timeouts.
- **Dedup atômico** no webhook (reserva antes de qualquer `await`), sem corrida entre mensagens.

### Correções
- **404 em `/group/fetchAllGroups`**: grupos, estado da conta, logout/QR, 2FA e sync de
  contatos passaram a resolver a instância **principal** em `instancias.json`; antes usavam
  `EVO_INSTANCE` fixo (`radar-piloto`), que deixa de existir quando o número é renomeado.
- **Compose neste host**: removido `no-new-privileges:true`, que no Docker 29 fazia o `exec`
  do entrypoint falhar com `operation not permitted`; `cap_drop`, `read_only` e limites mantidos.
- **`sendMedia 500` / imagem fora do ar**: o manager baixa a foto e envia em base64 (não depende
  do DNS da Evolution); se o media falhar, a oferta segue como texto com o link, sem ficar presa.
  O retry também exclui a instância que acabou de falhar (`Connection Closed`).
- **Amazon em revisão**: `AMAZON_TAG` estava vazia no `.env`; configurada a tag do canal e o
  transformer passou a publicar `?tag=...`. O teste seco dos ASINs reais confirmou `ENCAMINHADO`.
- **“Testar” inflava o painel**: `dryRun` registrava evento como `ENCAMINHADA`; agora a simulação
  não altera contadores nem consome dedup, então não bloqueia a oferta real seguinte.
- **Links de origem não reconhecidos**: `link.amazon`/`amzlinks.in` (2 saltos), `shozap.com.br`
  (Amazon/Shein), `promosdebrother.com` e `mercadolivre.com` passaram a ser expandidos antes de
  classificar; `oferta.emipefps.com` ganhou fallback por redirect quando a API falha.
- **Sync diário de grupos**: rotina às 06:00 (America/Sao_Paulo) busca grupos em TODAS as
  instâncias ativas, atualiza nomes e adiciona como origem apenas grupos que já publicaram
  oferta (link + preço) nos últimos 7 dias. Evita grupos pessoais/cursos. Painel e logs em
  `data/grupos-sync.json`; desligável com `MONITOR_SYNC_GRUPOS=0`.
- **Fila anti-rajada** reduzida de 120s para 60s (a pedido do operador), mantendo 1 envio por vez.
- **Envio partilhado**: todos os números ativos e `open` participam do envio — principal inclusive —
  na proporção do peso; o principal continua preferido para as operações de serviço.

### Operação
- `/healthz` e `/readyz`, `HOST` configurável (default `127.0.0.1`), request-id e log estruturado
  (pino) com redaction; shutdown gracioso (SIGTERM/SIGINT) drenando a fila.
- Escrita JSON atômica (`0600`/`0700`) em todo o estado; fila do monitor persiste o item em
  andamento e o devolve no boot (sem perder oferta em crash).
- Backup/restore cifrados com manifesto, `pg_dump` da Evolution e retenção; Dockerfile
  multi-stage non-root e Compose com healthcheck/limites/loopback.

### Testes
- `pretest` compila antes da suíte (fim do falso verde sem `dist/`); **118 testes** em 21 arquivos,
  incluindo SSRF/path traversal, reserva atômica, CSV injection e recuperação de fila.

### Documentação
- Janela de envio corrigida no comentário do agendador (`src/jobs/auto.ts` dizia "22h";
  o valor real é `JANELA_FIM`, default **23h**).
- IDs de requisito da fila/mídia alinhados à numeração canônica (`RF-043` e `RF-034`).

## [0.8.0] — 2026-10-22

Consolidação de **multi-número**, **clientes/campanhas**, **autenticação com 2FA**, **temas** e
**cupons ML**, além de resiliência do monitor a rate-limit do WhatsApp.

### Adicionado
- **Multi-número (anti-ban)**: cadastro de até 5 instâncias, rodízio ponderado (peso 1–10),
  anti-repetição de 70% (`RODIZIO_EVITA_REPETICAO`) e separação principal × secundários — o
  **principal** só faz operações de serviço e os **secundários** assumem o envio, com fallback ao
  principal se todos caírem (`src/wa/rotacao.ts`; #28).
- **Clientes**: sincronização de participantes dos grupos, listas de distribuição, cadastro manual
  e campanha com fila anti-bloqueio persistida (1 envio a cada `CLIENTES_INTERVALO_S`, default 60s)
  (`src/clientes/clientes.ts`).
- **Autenticação do painel**: login real com sessão em cookie (`alcance_sid`), `scrypt`, rate-limit,
  auditoria e **verificação de celular por código no primeiro acesso** (10 posições, validade 10 min)
  (`src/manager/auth.ts`, `src/manager/verificacao.ts`; #21).
- **Temas do painel**: seis paletas (`verde`, `laranja`, `areia`, `grafite`, `marrom`, `cacau`) e
  **títulos editáveis por card** persistidos em `data/ui.json`.
- **Programa Amazon** no Piloto (mesmo modelo do ML) + **aba Rastreio** de publicações (#16).
- **Cupons do Mercado Livre** (`src/ml/cupons.ts`).
- **Permissões de grupo** (somente admins falam/comentam) (#12).
- **Resolução de encurtadores** (ex.: `tidd.ly`) para não perder volume (#20).

### Alterado
- **Monitor**: envia oferta para todos os destinos ativos da origem (fan-out), com fila anti-rajada
  a partir da 4ª mensagem/min (`src/monitor/fila.ts`).
- **Dedup do monitor configurável** (`DEDUP_DIAS`, `DEDUP_POR_ORIGEM`) e diagnóstico de volume (#19).
- Comentário e valor da **janela de envio**: 8h–23h (`JANELA_INICIO`/`JANELA_FIM`); **não há mais
  limite diário** de mensagens por número.
- Persistência em **JSON atômico** sob `data/` (não usa SQLite).

### Corrigido
- Envio de mensagem tem **prioridade** sobre adição de contato ao grupo; em falha transitória a
  oferta **volta à fila** em vez de se perder (#27).
- Adição ao grupo em **gotejamento** com retry e job em background contra `rate-overlimit` (#22).
- Aba Monitor usa **cache de grupos** (stale-while-revalidate), abrindo instantaneamente e sem nova
  chamada à Evolution (#25, #26).
- Loops do Piloto voltam a agendar os timers no boot e ganham **botão religar** + config salva ao
  parar (#17, #18, #23).
- Lista de grupos deixa de aparecer em branco nos selects quando o grupo não tem nome (#15).
- Link **Shopee** passa a ser gerado pela Open API e `smtt` deixa de contar como afiliado (#9).

### Segurança
- **Gate default-deny** no painel: rotas sensíveis exigem sessão válida (`ef19144`).
- **2FA** por WhatsApp com hash salgado, expiração e trava por tentativas (`#21`).
- Auditoria com IP truncado em `/24` e rate-limit de login.

### Notas
- **Não implementado**: mensagens temporárias (efêmeras) de 7 dias no destino (RF-044); o monitor
  apenas desembrulha `ephemeralMessage`.
- **Adiado**: gateway de IA real (RF-005) — hoje a IA é um *stub* que só sugere título/subtítulo.

## [0.7.0] — 2026-10-21 (reconstruída do histórico)

### Adicionado
- **Monitor de grupos** de afiliados: webhook da Evolution, parser de ofertas, anti-loop, dedup e
  encaminhamento para grupos próprios (`src/monitor/*`).
- **Variações de números** e dedup do monitor (#19).
- Deploy em **rede limpa** e higiene do legado (`docs/08-deploy-rede-limpa.md`).

### Corrigido
- Correção de escape que quebrava todo o JS do painel (#11).

## [0.6.0] — 2026-10-20 (reconstruída do histórico)

### Adicionado
- **Piloto automático** (ML) com `src/ml/piloto.ts`, template RN-001 e publicação em grupos.
- **Painel de gestão** inicial (login, cards, paletas).
- **Cesta semente** e primeira versão do `README`.

---

> Versões abaixo de 0.6.0 não foram registradas formalmente; consulte o histórico do git para
> detalhes (`git log --oneline`).
