# 13 — Autenticação do painel Alcance (spec + protótipos)

> Status: **proposta para avaliação** | 2026-10-20 | E6-AUTH-01
> Protótipos: `docs/prototipos/auth/` (servir em `http://localhost:8100/`)
> Implementação: **bloqueada até a escolha da opção visual** (ver §9).

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

Erros: `401 {"erro":"credenciais inválidas"}`, `403` origem, `429` com `Retry-After`, `500` genérico sem stack.

## 5. Requisitos de segurança (MUST)

### 5.1 Credencial
- [ ] `crypto.scrypt` assíncrono (`N=2^15, r=8, p=1`, salt 16B, `maxmem=64MB`), formato versionado.
- [ ] `timingSafeEqual` sobre SHA-256 dos dois lados (tamanho fixo); hash dummy se usuário não existe.
- [ ] Limite de concorrência/timeout de hash (anti-DoS de CPU).
- [ ] Usuários em arquivo `0600` (`id`, `username`, `hash`, `role`, `disabled`, `createdAt`).
- [ ] Normalização/limite de tamanho de `username` e `password` antes do hash.

### 5.2 Sessão
- [ ] `sid` opaco 32B + HMAC-SHA256 (`SESSION_SECRET` ≥32B); server guarda `sha256(sid)`.
- [ ] Cookie `HttpOnly; SameSite=Strict; Path=/; Max-Age=...` sem `Domain`; `Secure`/`__Host-` com TLS.
- [ ] TTL absoluto (8–12h) + idle timeout (30min) validados no servidor.
- [ ] Rotação de `sid` no login (anti-fixation); logout apaga sessão e expira cookie.
- [ ] Limite de sessões por usuário; `disabled` invalida sessões; sweeper com `unref()`.

### 5.3 Login e anti-brute-force
- [ ] Resposta/tempo iguais para usuário inexistente, senha errada e desativado.
- [ ] Rate-limit por IP + usuário + global; backoff; `429` genérico com `Retry-After`.
- [ ] Falhas contadas antes do scrypt; sucesso limpa contadores.
- [ ] IP de `socket.remoteAddress`; `X-Forwarded-For` só com proxy conhecido.

### 5.4 CSRF e headers
- [ ] Origin/Referer allowlist em todo POST/PUT/PATCH/DELETE; `Sec-Fetch-Site` cross-site → 403.
- [ ] `Content-Type: application/json` nas mutações; body limit (login 64KB, webhook 1MB).
- [ ] CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP.
- [ ] `Cache-Control: no-store` em login/API autenticada; HSTS só com TLS.

### 5.5 Webhook e legado
- [ ] `WEBHOOK_KEY` fail-closed; `safeEqual`; header apenas; rate-limit; só POST.
- [ ] `MANAGER_KEY` sai do browser; se mantida, vira credencial machine só para `/api/*`.
- [ ] Nunca aceitar `MANAGER_KEY` para `GET /`/HTML.

### 5.6 Logs/LGPD
- [ ] Auditoria JSONL (`login_success`, `login_failure`, `logout`, `session_expired`, `rate_limited`, `forbidden_origin`) com IP truncado/UA/requestId.
- [ ] Nunca logar senha, hash, cookie, `sid`, chaves, CPF, telefone, e-mail ou corpo de login.
- [ ] Retenção definida e acesso restrito.

### 5.7 Transporte/deploy
- [ ] Boot fail-closed se `SESSION_SECRET`/`WEBHOOK_KEY`/usuário faltarem.
- [ ] Porta em `127.0.0.1` ou TLS via reverse proxy; documentar risco de HTTP em LAN.
- [ ] Container non-root; `.env` fora do git/imagem.

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

## 9. Decisões abertas (precisam de resposta antes do código)

1. **Qual das 3 opções visuais** será implementada? (1, 2 ou 3)
2. **Acesso:** só `localhost`/LAN confiável ou precisa de TLS/reverse proxy (Caddy) para LAN/WAN?
3. **Sessão:** TTL absoluto (8h? 12h?) e idle (30min?) — sugestão: 8h/30min.
4. **Usuários:** single `admin` agora ou já permitir 2–3 operadores com papéis?
5. **`MANAGER_KEY`:** descontinuar de vez ou manter só para integrações machine?
6. **Paletas no login:** usar as 6 do painel e a mesma chave `paleta` (recomendado).

## 10. Riscos

- **Login cosmético** se o gate não for server-side → mitigado por default-deny + testes.
- **DoS de CPU** com scrypt sem rate-limit/concorrência → mitigado por contadores antes do hash.
- **HTTP em LAN** expõe senha/cookie → TLS ou bind local documentado.
- **Sessão em memória** cai no restart → aceitável single process; documentar e evoluir para Redis se
  houver múltiplas instâncias.
- **XSS** ainda executa ações mesmo com cookie `HttpOnly` → CSP e escape de dados.
