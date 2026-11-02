# Protótipo — título do produto no rastreio (monitor)

**Objetivo**: na aba **Rastreio**, as publicações feitas pelo **monitor** aparecem como
`MLB5864818802` (código). O piloto já aparece com o título. Este protótipo fixa o alvo
visual: a mesma linha passa a exibir o **título do produto postado**.

**Status**: aprovado implicitamente pela demanda — implementado em
`src/monitor/titulo.ts` + `src/monitor/fila.ts`.

## Arquivos

| Arquivo | Mostra |
|---|---|
| `antes-depois.html` | comparativo lado a lado da linha do rastreio (antes: código; depois: título) |

## Parâmetros

- Reaproveita o layout atual da lista (`/api/rastreio` → `#rtlista`): data, programa,
  título, categoria, link "abrir".
- Fonte: `system-ui`; cores herdadas das variáveis do painel (`--border`, `--mini`).
- Sem colunas novas: o título ocupa o mesmo slot que hoje exibe o código.
- Fallback continua `p.titulo || p.id` — se não houver título, mostra o código.

## Como abrir

```bash
xdg-open docs/prototipos/rastreio-titulo/antes-depois.html
```

## Decisões

1. **De onde vem o título**: `tr.produto.titulo` (og:title do anúncio) quando o
   transformador resolve; senão, heurística sobre o texto postado na origem
   (primeira linha útil, sem preço/emoji).
2. **Itens já na fila**: o título também é extraído do corpo no momento do envio, então
   publicações antigas passam a ter título sem migração.
3. **Categoria**: deixa de ser o JID do grupo de origem (vazava `120363...@g.us`) e passa
   a ser o programa (`ml`, `shopee`, `amazon`, `kabum`).
4. **Programa**: corrigido `mercadolivre` → `ml` (antes caía em `desconhecido`).

## Pendências

- Se o `ML_CONVERSOR_URL` for configurado, o título vem do anúncio (mais limpo) em vez da
  heurística.
