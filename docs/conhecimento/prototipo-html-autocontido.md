# Protótipo HTML: abrir no navegador antes de dar por pronto

## Sintoma
Um protótipo HTML "entregue" renderizava com o CSS impresso como texto puro na página —
e, numa segunda variante, as tabelas, os cards e os banners apareciam **sem estilo nenhum**,
sem nenhum erro no console.

## Causa
Dois defeitos de marcação, ambos invisíveis para leitura de código:

1. **Tag `<style>` de abertura ausente** — o bloco de CSS entrava no corpo como texto.
2. **Bloco `@media` do painel-base nunca fechado** — todo o CSS extra do protótipo ficava
   aninhado dentro da media query e **não se aplicava no desktop** (a janela de teste era
   larga, então o bug não aparecia em inspeção estática).

## Padrão adotado
Validar o protótipo **de verdade no navegador**, não só "confere sintaxe":

1. abrir o arquivo e conferir o **console** (o único 404 aceitável é `favicon.ico`);
2. conferir `getComputedStyle` de um elemento-chave (o `display` esperado, não o herdado);
3. conferir **zero recurso externo** (`img`/`script[src]`/`link[href]`/`iframe` e URLs em CSS);
4. conferir que a tabela mais densa **cabe sem rolagem lateral**
   (`scrollWidth == clientWidth`) e que a coluna de **ações fica visível**;
5. percorrer os **estados** (vazio, grande, erro, carregando) e as **ações**
   (confirmar, executar, conferir o contador depois).

## Auditoria de seletores herdados
Protótipo que copia o vocabulary visual de um painel real precisa conferir os seletores que
o painel usa e o protótipo não (`.alerta`/`.malerta`, `.empty`, `.spin`, `.badge`, `.num`,
`.nowrap`, `.trunc`): se a regra CSS não existe, o elemento renderiza "cru" — **sem erro no
console**.

## Evidência
- Issue #53 / PR #64 (`docs/prototipos/mensageria/`); corrigidos: `<style>` ausente, `@media`
  não fechado, `.alerta` sem regra, pluralização "4 mensagems", coluna "Mais antiga" com
  hora e idade invertidas.

## Regra geral
Protótipo é **artefato executável**: a prova de que está pronto é o navegador aberto com o
arquivo, não o diff.
