# 07 — Protótipo Resultado Esperado [v0.3 CATEGORIAS ML + KEYWORD]

> v0.3 | 2026-10-12 | Abra `docs/prototipo/index.html` — lista suspensa oficial + palavra-chave opcional.

## 1. O que mudou (v0.2 → v0.3, seu pedido)
- **Categorias em lista suspensa (`<select>`)** com os nomes oficiais de https://www.mercadolivre.com.br/categorias (31 opções PT-BR: Acessórios para Veículos, Agro, Alimentos e Bebidas, Animais e Pets, ..., Joias e Relógios, Celulares e Telefones, Eletrodomésticos, etc.).
- **Palavra-chave opcional:** campo texto abaixo da suspensa. Vazio = busca **em toda a categoria** (`só ?category=ID`). Com texto = busca **categoria + q** (`?category=ID&q=Orient`).
- Protótipo mostra a chamada real que o backend fará em `GET /sites/MLB/search`.

## 2. Contrato oficial usado
- Listar: `GET https://api.mercadolibre.com/sites/MLB/categories` → `[{id, name}]` (ex. confirmado `MLB5672 Acessórios para Veículos`, `MLB271599 Agro`, `MLB1403 Alimentos e Bebidas`).
- Buscar: `GET https://api.mercadolibre.com/sites/MLB/search?category=MLB3937` (toda categoria) ou `?category=MLB3937&q=Orient` (filtrada). Doc: developers.mercadolivre.com.br + guia `mercado-livre-api-guide`.
- Limitação ambiente: a página /categorias exigiu verificação e a API direta retornou 403 aqui, então o HTML usa a lista oficial em cache; em runtime o app resolve os IDs ao vivo (com fallback por nome). Nenhum ID foi inventado como definitivo — os 3 primeiros são confirmados, os demais seguem o mesmo contrato.

## 3. Roteiro no HTML
1. Seleciona `Joias e Relógios` (default, cobre seu Orient) → deixa keyword vazia → vê Top3 da categoria inteira.
2. Digita `Orient` → a caixa da API vira `?category=MLB3937&q=Orient` e a lista/mensagem filtram.
3. Troca para `Celulares e Telefones` + `Samsung` → novo Top3.
4. Toggle AUTO ON/OFF + `Buscar oportunidades` → log + bolha WhatsApp atualiza (mantém RN-001).

## 4. Saída continua igual (RN-001 intacta)
Exemplo categoria inteira ou filtrada por “Orient” cai na mesma mensagem do Orient MBSS1171 quando ele é o Top1.

## 5. Aceite v0.3
- [ ] Suspensa contém as categorias do link oficial.
- [ ] Vazio busca tudo; com keyword filtra (visível na caixa da API).
- [ ] Mensagem final igual v0.1/v0.2.
- [ ] Responsivo.

```bash
xdg-open docs/prototipo/index.html
```
