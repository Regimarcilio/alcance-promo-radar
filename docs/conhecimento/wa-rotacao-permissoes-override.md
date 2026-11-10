# Rotação de remetentes: permissões, pausa e override por fluxo

## Contexto
Os três fluxos (Piloto, Monitor, Disparo) compartilham `enviarParaGrupo()` →
`src/wa/dispatch.ts` → `proximaInstancia()`. Não havia como restringir um número a um
fluxo, pausar um número sem desativá-lo, nem fixar manualmente o remetente.

## Padrão adotado
1. **Filtro no ponto único.** `proximaInstancia(fluxo, excluir)` aplica
   `permissoes[fluxo]`, `!pausado`, `ativo` e (depois) `open`/saudável. Cada chamador
   informa o próprio fluxo; `fluxo` ausente mantém o comportamento legado e ainda
   respeita `pausado`.
2. **Nunca sortear número proibido.** Se o filtro zera os candidatos, lançar erro claro
   em vez de cair no fallback de "primeiro ativo". O `comRetry` do dispatch propaga o erro.
3. **Migração retrocompatível.** Campos novos ausentes no JSON = `permissoes` todas true e
   `pausado: false`; o comportamento antigo é preservado sem regravar o arquivo.
4. **Override com fallback.** O fixado só é usado se existir, estiver ativo, permitido,
   despausado, `open` e não tiver falhado no retry; senão loga aviso e cai no sorteio
   ponderado. Um único override por fluxo (limpa nos demais ao definir).
5. **UI mínima.** A aba Números não foi redesenhada: toggles por fluxo + Pausar/Continuar
   na linha e um seletor discreto por fluxo no topo.

## Evidência
- Issue #36 / PR #39: permissões + pausa; 197 testes verdes.
- Issue #37 / PR #40: override por fluxo; 202 testes verdes.
- `src/wa/rotacao.test.ts`, `src/wa/dispatch.test.ts`.

## Anti-padrão evitado
Filtrar apenas na UI (ou em cada chamador): o próximo fluxo novo esquece o filtro e
envia por número proibido. O filtro tem de viver no sorteio, não na tela.
