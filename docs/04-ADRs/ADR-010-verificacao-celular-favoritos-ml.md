# ADR-010 — Verificação de celular no primeiro acesso + favoritos do ML

> Data: 2026-10-21 | Status: Aceita

## Contexto

Dois pedidos do operador:

1. **Segurança no acesso**: além de usuário e senha, o cadastro passa a exigir um **WhatsApp
   válido** e o sistema envia para o celular um **código alfanumérico de 10 posições**, pedido no
   primeiro uso. O objetivo é amarrar a conta a um celular real (e o celular serve como canal
   oficial do usuário).
2. **Favoritos do Mercado Livre**: a cada oferta enviada ao grupo, o item deveria ser adicionado
   automaticamente à lista de favoritos do afiliado — assim o cliente que clica no link teria mais
   opções para navegar.

Sobre o item 2, a verificação na documentação oficial do ML mostrou limites importantes:
`POST /users/me/bookmarks` existe e funciona, **mas** (a) exige **access token OAuth** — o projeto
hoje usa TAG + COOKIE, que não autenticam essa API; e (b) os favoritos são **da conta do
afiliado**: o cliente final **não** vê a sua lista ao clicar no link. O que o cliente vê ao clicar é
a vitrine do vendedor de cada oferta, oferecida nativamente pelo ML.

## Decisão

**Verificação de celular**
- `src/manager/verificacao.ts`: código alfanumérico de 10 posições (alfabeto sem 0/O e 1/I, para não
  errar ao digitar), **SHA-256 com sal do usuário** gravado (o texto puro nunca toca o disco),
  validade de 10 min, trava após 5 tentativas, comparação em tempo constante.
- O código puro fica **em memória** (Map do processo) só para permitir *reenviar o mesmo código* —
  assim o usuário não precisa trocar de código a cada tentativa.
- `scripts/auth-user.mjs` passa a exigir `--telefone` (ou `AUTH_TELEFONE`) e envia o código na hora
  do cadastro; se a Evolution estiver fora, o cadastro **continua** e o código é gerado no 1º login.
- `POST /api/auth/login` responde `{precisaCodigo:true, telefone:"55•••9999"}` quando falta o
  código; `POST /api/auth/reenviar-codigo` reenvia (gerando um novo).
- **Compatibilidade**: usuário **sem** celular cadastrado continua entrando só com usuário e senha.

**Favoritos do ML**
- `src/ml/favoritos.ts`: `POST /users/me/bookmarks` com `item_id`, exigindo `ML_ACCESS_TOKEN`.
  Sem token, o módulo é **inerte** (nenhuma chamada de rede). Falha ao favoritar **nunca** derruba a
  publicação da oferta.

## Consequências

- **+** Conta amarrada a um celular real; o número oficial do usuário fica no cadastro.
- **+** O código nunca é gravado em texto puro; há expiração e trava por tentativas.
- **+** Favoritos: vitrine central do que foi divulgado (com token OAuth disponível).
- **−** O cadastro agora exige celular — o operador precisa ter a Evolution no ar para o código
  chegar.
- **−** Os favoritos do ML **não** aumentam as opções do cliente final (são da conta do
  afiliado); para isso, o caminho é divulgar a vitrine do **próprio** vendedor.
- **−** O módulo de favoritos depende de token OAuth (a obter em "Mercado Livre → Ferramentas →
  Aplicativos → Associados"), e itens de terceiros podem ser recusados pela API.

## Referências

- Implementação: `src/manager/verificacao.ts`, `src/ml/favoritos.ts`, `scripts/auth-user.mjs`,
  `src/manager/login.html`
- SRS: RF-036 / RF-037
- Docs ML: `developers.mercadolivre.com.br/pt_br/favoritos`
