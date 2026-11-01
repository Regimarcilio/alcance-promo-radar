# Protótipo — mensagem de boas-vindas ao novo membro

> Status: **aprovado e implementado** (2026-10-31) — opção 1.
> Tema: mensagem personalizada enviada ao contato recém-adicionado ao grupo
> "Mano dos Achadinhos", usando a imagem da marca e o link do TikTok.

## Objetivo

Reduzir a saída dos ~10% que abandonam o grupo logo após a adição. A janela de
adição é 6h–22h, mas o envio de ofertas vai até 23h — quem entra às 6h ficaria
horas sem estímulo. A mensagem de boas-vindas (e, opcionalmente, um resumo dos
5 últimos anúncios) cobre esse vazio.

## Arquivos

| Arquivo | O que mostra |
|---|---|
| `opcao-1.html` | Mensagem única: imagem da marca + legenda + link do TikTok. |
| `opcao-2.html` | Opção 1 + bloco com os 5 anúncios mais recentes (dois momentos: confirmação e 23h). |
| `opcao-1.png` | Screenshot da opção 1 (prévia WhatsApp + texto exato). |
| `opcao-2.png` | Screenshot da opção 2 (boas-vindas e resumo das 23h). |

## Como abrir

```bash
xdg-open docs/prototipos/boas-vindas-novos-membros/opcao-1.html
xdg-open docs/prototipos/boas-vindas-novos-membros/opcao-2.html
```

Os HTMLs são autocontidos (CSS embutido) e referenciam a imagem real do projeto
em `../../../image/Mano dos Achadinhos_ Ofertas Tech e Lifestyle.png`.

## Parâmetros

- Imagem: `image/Mano dos Achadinhos_ Ofertas Tech e Lifestyle.png` (1254×1254, PNG sRGB).
- Formato: imagem + legenda na mesma mensagem (limite de legenda do WhatsApp: 1024 caracteres).
- Canal: DM do contato recém-adicionado (não no grupo).
- Gatilho: entrada confirmada no grupo (status `200` do add).
- Link: https://www.tiktok.com/@mano.dos.achadinh
- Fonte do resumo (opção 2): `data/publicacoes.json`, últimos 5 com `titulo` não vazio.

## Decisões pendentes

1. **Uma mensagem ou mensagem + resumo?** (opção 1 × opção 2)
2. **Se opção 2: envio imediato (A) ou resumo às 23h (B)?** Recomendação: B.
3. **Resumo com ou sem links?** Recomendação: sem links, para reduzir risco de bloqueio.
4. **Texto final da legenda** — aprovar ou ajustar tom/emoji.
