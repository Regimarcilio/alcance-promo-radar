# Rastreio: teto de armazenamento não é total publicado

## Sintoma
KPI "publicações" congelado em 5000.

## Causa
`LIMITE_PUBLICACOES = 5000` era só o teto do arquivo (`slice(-5000)`), mas o resumo usava
`listarPublicacoes().length` — impossível passar de 5000.

## Padrão adotado
1. Teto **configurável** por env (`RASTREIO_LIMITE`, default 50000, piso 1000).
2. **Contador histórico separado** (`data/rastreio-total.json`), incrementado a cada
   registro e nunca decrementado pela poda.
3. `resumoRastreio()` expõe `total` (histórico), `armazenados` (arquivo) e `limite`.
4. Migração: meta ausente → inicializa com o tamanho atual do arquivo; nunca retrocede
   (`Math.max(meta.total, armazenados)`).
5. Lista/CSV continuam operando sobre o que está armazenado (filtros inalterados).

## Evidência
- Issue #38 / PR #41; `src/store/publicacoes.test.ts` (10 testes verdes).

## Regra geral
Sempre que houver poda de arquivo, separe **quantos existem** de **quantos estão
guardados**. Um único número não consegue representar os dois.
