# ADR-008 — Painel: temas visuais e títulos editáveis por card

> Data: 2026-10-22 | Status: Aceita (implementada; `src/manager/pagina.test.ts` verde)

## Contexto

O painel nasceu com uma única aparência (tema verde) e títulos fixos no HTML. O operador pediu
identidade visual própria e a possibilidade de renomear os cards conforme o vocabulário do negócio,
sem depender de alteração de código a cada ajuste de nome.

## Decisão

**Temas (paletas)**
- Seis paletas em CSS por atributo `data-paleta` no `<html>`: `verde` (padrão), `laranja`, `areia`,
  `grafite`, `marrom` e `cacau`.
- A escolha é persistida em `localStorage` (`paleta`) e aplicada por um script inline **antes** do
  render (evita "flash" de tema errado). O seletor vive no próprio painel e reaplica
  `raiz.setAttribute('data-paleta', p)` em tempo real.

**Títulos dos cards**
- `src/ui/titulos.ts` mantém os títulos editáveis persistidos em `data/ui.json`, com fallback para
  `TITULOS_PADRAO`.
- Cards suportados hoje: `piloto`, `monitor`, `numeros`, `clientes`.
- Limite de **60 caracteres** por título; título vazio é rejeitado; chave desconhecida é rejeitada.
- Escrita atômica (`.tmp` + rename) para não corromper o arquivo.

**Views / navegação**
- O painel tem views dinâmicas por aba (sidebar), incluindo as abas de Monitor, Números e Clientes,
  sem recarregar a página.

## Consequências

- **+** Identidade visual ajustável sem recompilar nada; a preferência fica no navegador do operador.
- **+** Títulos mudáveis pela UI deixam o painel alinhado ao vocabulário do negócio.
- **+** Sem "flash" de tema e escrita atômica: ajustes pequenos e seguros.
- **+** Novo card exige apenas uma entrada em `TITULOS_PADRAO` (mudança mínima de código).
- **−** `localStorage` é por navegador/dispositivo: tema não sincroniza entre máquinas.
- **−** As paletas são CSS embutido no `server.ts` (arquivo grande); não há tema customizado pelo
  usuário além das seis opções.
- **−** Títulos são globais do painel (não por usuário).

## Referências

- Implementação: `src/ui/titulos.ts`, `src/manager/server.ts` (paletas e views)
- Testes: `src/manager/pagina.test.ts` (3)
- SRS: RF-048 (views dinâmicas e títulos editáveis), RF-049 (temas); RN-022 (temas)
