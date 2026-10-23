# ADR-005 — Autenticação do painel: sessão em cookie + 2FA por código no celular

> Data: 2026-10-22 | Status: Aceita (implementada; `src/manager/auth.test.ts` e `verificacao.test.ts` verdes)

## Contexto

O painel de gestão (`src/manager/server.ts`) expõe ações destrutivas e sensíveis: pausar/retomar o
piloto automático, editar grupos de monitor, cadastrar números, disparar campanhas para clientes e
alterar títulos do painel. Essas rotas ficaram expostas em rede local sem autenticação, o que é
inaceitável assim que o painel passa a rodar fora de `localhost`.

O operador pediu também que o acesso fosse amarrado a um **celular real** — não apenas usuário e
senha — para reduzir o risco de uso indevido se a senha vazar. Como o produto já fala com a
Evolution/WhatsApp, o próprio WhatsApp serve de canal de segundo fator.

## Decisão

**Senha**
- Hash `scrypt` com `N = 2^15 (32768)`, `r = 8`, `p = 1` e sal aleatório, gravado em formato
  versionado `scrypt$N$r$p$salt$hash` (permite migrar parâmetros no futuro sem quebrar hashes
  antigos). Verificação em tempo constante.

**Sessão**
- Identificador `sid` aleatório + assinatura HMAC; store **em memória** do processo (não persiste).
- TTL absoluto de 8h (`AUTH_TTL_HORAS`) e idle de 30 min (`AUTH_IDLE_MIN`).
- Máximo de **5 sessões simultâneas por usuário** (`MAX_SESSOES_POR_USUARIO`); ao estourar, a mais
  antiga é descartada.
- Cookie `alcance_sid` com `HttpOnly`, `SameSite=Strict`, `Path=/` e `Max-Age`; `Secure` é opcional
  via variável de ambiente (para uso atrás de HTTPS).

**Rate-limit e auditoria**
- 5 tentativas/min por IP, com bloqueio de 60s ao estourar; teto global adicional de 30/min.
- Eventos de autenticação gravados em JSONL de auditoria, com IP truncado em `/24` (não guarda o IP
  completo), para diagnóstico sem expor o dado bruto.

**2FA por código alfanumérico (primeiro acesso)**
- `src/manager/verificacao.ts`: código de **10 posições**, alfabeto sem `0/O` e `1/I` (para evitar
  erro de digitação), validade de 10 min, trava após 5 tentativas, comparação em tempo constante.
- O texto puro **nunca** toca o disco: grava-se `SHA-256` com sal do usuário. O código puro fica
  **em memória** apenas para permitir reenviar o mesmo código sem trocar a cada tentativa.
- `scripts/auth-user.mjs` passa a exigir `--telefone` (ou `AUTH_TELEFONE`) e dispara o código no
  cadastro; se a Evolution estiver fora, o cadastro **continua** e o código é gerado no primeiro
  login.
- `POST /api/auth/login` responde `{ precisaCodigo: true, telefone: "55•••9999" }` quando falta o
  código e o telefone é exibido **mascarado**; `POST /api/auth/reenviar-codigo` reenvia um novo
  código na hora do cadastro.
- **Compatibilidade**: usuário **sem** telefone cadastrado continua entrando só com usuário e senha.

## Consequências

- **+** Rotas sensíveis do painel deixam de ser anônimas; sessão expira sozinha (absoluto + idle).
- **+** 2FA amarra a conta a um celular real sem banco de dados — reaproveita a Evolution já existente.
- **+** Código nunca é persistido em texto puro; há expiração e trava por tentativas.
- **+** Auditoria com IP reduzido atende LGPD/boas práticas sem perder rastreabilidade.
- **−** Sessões e códigos vivem em memória: reiniciar o processo derruba todas as sessões e invalida
  códigos pendentes (aceitável para o porte atual).
- **−** O cadastro com telefone depende da Evolution no ar para o código chegar; sem ela, o usuário
  fica sem 2FA até reenviar.
- **−** Rate-limit é por processo/IP; atrás de proxy é preciso confiar no cabeçalho de IP encaminhado.

## Referências

- Implementação: `src/manager/auth.ts`, `src/manager/verificacao.ts`, `src/manager/server.ts`,
  `scripts/auth-user.mjs`, `src/manager/login.html`
- Testes: `src/manager/auth.test.ts` (7), `src/manager/verificacao.test.ts` (8)
- SRS: RF-040 (login/sessão/default-deny), RF-041 (rate-limit/auditoria/headers),
  RF-036 (verificação de celular); RN-017 (sessão), RN-018 (2FA)
- Spec detalhada: `docs/13-auth-spec.md`
