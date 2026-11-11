# 13 — Autenticação do painel Alcance (spec + implementação)

> Status: **implementado** (E6-AUTH-02) | 2026-10-20
> Protótipos: `docs/prototipos/auth/` (opção **1 — Sala de controle** aprovada)
> Código: `src/manager/auth.ts`, `src/manager/login.html`, `src/manager/server.ts`,
> `scripts/auth-user.mjs`; testes em `src/manager/auth.test.ts`.

## 1. Contexto atual (por que a tela não basta)

O manager (`src/manager/server.ts`, Node `http` puro) **não tem login**. Hoje existe apenas:

- `MANAGER_KEY` opcional no `.env`; se definida, **somente POSTs** exigem `x-manager-key`.
- `GET /` e todos os `GET /api/*` ficam **abertos** (leitura de contas, clientes, telefones, filas).
- A UI guarda a chave em `sessionStorage['mkey']` e a injeta em requests non-GET; em 401 abre `prompt()`.
- `MANAGER_KEY` vazia = painel aberto (fail-open).
- Webhook `/api/webhook/evolution` é isento e usa `WEBHOOK_KEY`.
- Comparações atuais com `!==` (não timing-safe).

**Consequência:** uma tela de login sem gate server-side é cosmética. A implementação precisa mover a
proteção para o servidor (default-deny) e aposentar o modelo de chave no browser.

## 2. Objetivo e escopo

**Objetivo:** proteger o painel inteiro com login de operador, sessão server-side e logout, sem quebrar o
webhook do Evolution.

**IN:**
- Tela de login (opção visual escolhida) + estados de erro/loading/sucesso.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- Sessão em cookie `HttpOnly` + store em memória (single process).
- Gate default-deny em `GET /` e `/api/*` (exceto allowlist).
- Rate-limit/lockout, CSRF por Origin, headers de segurança, auditoria sem PII.
- Remoção da `MANAGER_KEY` do browser/`sessionStorage`.

**OUT (por agora):**
- Cadastro público, login social, recuperação de senha por e-mail, 2FA, multiusuário com papéis.
- Persistência de sessão em Redis/banco (documentar limitação de restart).
- TLS/reverse proxy (necessário se houver acesso fora de localhost — decisão em §9).

## 3. Persona e credencial

- Operador único (`admin`) nesta entrega; estrutura de usuários já com `role` para evolução.
- Senha **nunca** em texto no `.env`; bootstrap por CLI que gera hash `scrypt`.
- Conta demo dos protótipos (`admin`/`alcance`) é **apenas mock** — não usar em produção.

## 4. Rotas e contrato

| Rota | Auth | Observação |
|---|---|---|
| `GET /login` | pública | serve a tela; `no-store` |
| `POST /api/auth/login` | pública | JSON, rate-limit, Origin |
| `POST /api/auth/logout` | sessão | invalida no servidor + expira cookie |
| `GET /api/auth/me` | sessão | hidrata a UI |
| `POST /api/webhook/evolution` | `WEBHOOK_KEY` | fora do login, fail-closed |
| `GET /` + `GET /api/*` | sessão | default-deny |
| novas rotas | sessão | allowlist explícita, nunca "tudo menos login" |

Erros: `401 {"erro":"usuário ou senha inválidos"}`, `403` origem, `429` com `Retry-After`,
`503` com `Retry-After` se o hash estiver saturado, `500` genérico sem stack.

## 5. Requisitos de segurança (MUST)

### 5.1 Credencial
- [x] `crypto.scrypt` assíncrono (`N=2^15, r=8, p=1`, salt 16B, `maxmem=64MB`), formato versionado.
- [x] `timingSafeEqual` sobre SHA-256 dos dois lados (tamanho fixo); hash dummy se usuário não existe.
- [x] Limite de concorrência/timeout de hash (anti-DoS de CPU): 4 hashes simultâneos; excedente → 503.
- [x] Usuários em arquivo `0600` (`id`, `username`, `hash`, `role`, `disabled`, `createdAt`).
- [x] Normalização/limite de tamanho de `username` e `password` antes do hash.

### 5.2 Sessão
- [x] `sid` opaco 32B + HMAC-SHA256 (`SESSION_SECRET` ≥32B); server guarda `sha256(sid)`.
- [x] Cookie `HttpOnly; SameSite=Strict; Path=/; Max-Age=...` sem `Domain`; `Secure`/`__Host-` com TLS.
- [x] TTL absoluto (8h) + idle timeout (30min) validados no servidor.
- [x] Rotação de `sid` no login (anti-fixation); logout apaga sessão e expira cookie.
- [x] Limite de sessões por usuário (5); `disabled` invalida sessões; sweeper com `unref()`.

### 5.3 Login e anti-brute-force
- [x] Resposta/tempo iguais para usuário inexistente, senha errada e desativado.
- [x] Rate-limit por IP (5/min) + global (30/min); backoff; `429` genérico com `Retry-After`.
      Per-user não bloqueia (evita lockout DoS); falhas ficam na auditoria.
- [x] Falhas contadas antes do scrypt; sucesso limpa contadores do IP.
- [x] IP de `socket.remoteAddress`; `X-Forwarded-For` só com `TRUST_PROXY=1`.

### 5.4 CSRF e headers
- [x] Origin allowlist + `Sec-Fetch-Site: cross-site` → 403 em todo POST/PUT/PATCH/DELETE.
- [ ] `Content-Type: application/json` obrigatório no login; demais mutações validam JSON no parse.
- [x] CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP.
- [x] `Cache-Control: no-store` em login/API autenticada; HSTS fica para a etapa de TLS.

### 5.5 Webhook e legado
- [x] `WEBHOOK_KEY` fail-closed (boot exige ≥16 chars); `safeEqual`; header apenas; só POST.
- [ ] Rate-limit do webhook não foi aplicado (Evolution pode rajada; rede privada + chave).
- [x] `MANAGER_KEY` saiu do browser; virou credencial machine opcional só para `/api/*`.
- [x] Nunca aceitar `MANAGER_KEY` para `GET /`/HTML.

### 5.6 Logs/LGPD
- [x] Auditoria JSONL (`login_ok`, `login_falha`, `logout`, `rate_limited`, `origem_invalida`)
      com IP /24, UA e evento; sem requestId nesta entrega.
- [x] Nunca logar senha, hash, cookie, `sid`, chaves, CPF, telefone, e-mail ou corpo de login.
- [ ] Retenção/rotação do `auth-audit.log` ainda não definida (cresce append-only).

### 5.7 Transporte/deploy
- [x] Boot fail-closed se `SESSION_SECRET`/`WEBHOOK_KEY`/usuário faltarem.
- [x] Porta publicada em `127.0.0.1` (compose); TLS via reverse proxy fica como próxima etapa.
- [ ] Container ainda roda como root; `.env` fora do git/imagem (não copiado no Dockerfile).

## 6. UX e acessibilidade da tela

- Estados: idle, foco, inválido, loading (`aria-busy`), erro (`role=alert`), sucesso, sessão expirada.
- Labels associados, `autocomplete`, toggle de senha com `aria-pressed`, foco visível, alvos ≥44px.
- Contraste AA; layout 390px sem overflow; teclado completo; `prefers-reduced-motion` desliga animações.
- Sem cadastro/social fake; dica da conta demo apenas no protótipo.
- Animações ≤300ms na entrada e ≤700ms no sucesso, só `transform`/`opacity`.

## 7. Protótipos (avaliação)

| Opção | Conceito | Animação | Arquivo |
|---|---|---|---|
| 1 | **Sala de controle** — split-screen, orbs, cartão | stagger, orbs, selo desenhado | `opcao-1.html` |
| 2 | **Esteira de ofertas** — marquee de ofertas | marquee, parallax, wipe | `opcao-2.html` |
| 3 | **Radar** — tema escuro, sweep e blips | radar, glow, ripple | `opcao-3.html` |

Critérios: identidade com o painel, propósito da animação, clareza, acessibilidade, transição de sucesso,
comportamento nas paletas. O seletor do protótipo cobre 4 das 6 paletas; a implementação usará as 6 e a
chave `paleta` do painel.

## 8. Critérios de aceite (Gherkin)

```gherkin
Cenário: login válido
  Dado que estou em /login
  Quando envio admin + senha correta
  Então recebo 200 e cookie HttpOnly de sessão
  E GET / passa a servir o painel

Cenário: credencial inválida
  Quando envio usuário inexistente ou senha errada
  Então recebo 401 com a mesma mensagem e tempo aproximado
  E nenhum cookie de sessão é emitido

Cenário: painel protegido
  Dado que não tenho sessão
  Quando acesso GET / ou qualquer /api/*
  Então recebo 401 (API) ou a tela de login (/)

Cenário: logout
  Quando chamo POST /api/auth/logout
  Então a sessão é apagada no servidor e o cookie expirado

Cenário: brute force
  Quando excedo o limite de tentativas
  Então recebo 429 com Retry-After

Cenário: webhook
  Quando o Evolution chama /api/webhook/evolution com WEBHOOK_KEY válida
  Então o evento é processado mesmo sem sessão
```

## 9. Decisões tomadas (2026-10-20)

1. **Opção visual:** 1 — **Sala de controle** (split-screen + selo), aprovada pelo usuário.
2. **Acesso:** HTTP apenas em **`127.0.0.1:8099`** agora. TLS/reverse proxy é etapa separada,
   obrigatória antes de expor na LAN/WAN.
3. **Sessão:** **8h absoluto + 30min idle** (`AUTH_TTL_HORAS`, `AUTH_IDLE_MIN`).
4. **Usuários:** **single `admin`** em `data/auth-users.json`; bootstrap por
   `npm run auth:user -- admin` (hash scrypt, arquivo `0600`).
5. **`MANAGER_KEY`:** mantida só como **credencial machine opcional** para `/api/*`;
   nunca é aceita para HTML e saiu do `sessionStorage`.
6. **Paletas:** as **6** do painel, compartilhando a chave `paleta` com o login.

## 9.1 Implementação (E6-AUTH-02)

- **Arquivos:** `src/manager/auth.ts` (hash/sessão/rate-limit/auditoria), `src/manager/login.html`
  (opção 1 com 6 paletas), `src/manager/server.ts` (rotas + gate + headers), `scripts/auth-user.mjs`
  (CLI), `src/manager/auth.test.ts` (7 testes).
- **Rotas:** `GET /login` e `POST /api/auth/login` públicas; `POST /api/auth/logout`,
  `GET /api/auth/me` com sessão; `GET /` e `/api/*` default-deny; webhook isento com `WEBHOOK_KEY`.
- **Sessão:** cookie `alcance_sid` (`HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`),
  `sid` 32B + HMAC, store em memória, `cacheUsers` por mtime, sweeper de 5min.
- **Boot:** falha se `SESSION_SECRET` <32, `WEBHOOK_KEY` <16 ou nenhum usuário ativo.
- **Rate-limit:** 5/min por IP + 30/min global; 4 hashes simultâneos; `429`/`503` com `Retry-After`.
- **Deploy:** `docker-compose.manager-novo.yml` publica `127.0.0.1:8099`; `.env` ganhou
  `SESSION_SECRET`, `AUTH_TTL_HORAS`, `AUTH_IDLE_MIN`, `AUTH_COOKIE_SECURE`.
- **Trocar senha:** `AUTH_PASSWORD='...' npm run auth:user -- admin` e reiniciar o manager.
- **Validação:** 22/22 testes; curl (302/401/200/429) e Playwright (desktop 1440×900 e mobile 390×844,
  login/erro/sucesso/logout, 0 erros JS, `scrollWidth=390`).

## 10. Riscos

- **Login cosmético** se o gate não for server-side → mitigado por default-deny + testes.
- **DoS de CPU** com scrypt sem rate-limit/concorrência → mitigado por contadores antes do hash.
- **HTTP em LAN** expõe senha/cookie → porta publicada só em `127.0.0.1`; TLS antes de LAN.
- **Sessão em memória** cai no restart → aceitável single process; evoluir para Redis se houver
  múltiplas instâncias.
- **NAT do Docker** faz todos os clientes parecerem o mesmo IP (`172.19.0.0/24` na auditoria);
  o limite por IP vira quase global. Com reverse proxy, usar `TRUST_PROXY=1`.
- **Container root** ainda grava `data/` como root; ao migrar para non-root, ajustar ownership.
- **XSS** ainda executa ações mesmo com cookie `HttpOnly` → CSP (com `unsafe-inline` por causa dos
  `onclick` legados) e escape de dados. Refatorar handlers inline numa próxima passada.
