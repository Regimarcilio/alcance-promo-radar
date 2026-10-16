# 11 — Padrão de mensagem Emipe (RN-001 v2)

> Fonte: `movie/Screen_Recording_20261014_091405_WhatsApp.mp4`
> (grupo "#55 Emipe Promoções", 15s, 3 variantes). Substitui o padrão
> antigo (headline em negrito + âncora De/Por + rodapé 🤖).

## Template (só o essencial)

```
[marca  (opcional, via MARCA_HANDLE/MARCA_NOME — ex. "@radar  Radar  #anúncio")]

🔥 {titulo do produto}
[ℹ️ {instrução do Pix} — opcional, ex. Amazon]
💵 R$ {pix} (Pix)
[⭐ Em até {n}x sem juros — só se parcelado conhecido]
[🚚 {frete} — só se conhecido; NUNCA inventar "Prime"]
[🎟️ Cupom: {CUPOM} — só se houver]
{link afiliado}
```

## Regras extraídas do vídeo

1. **Foto sempre** (sendMedia com a foto real do produto).
2. **Título com 🔥, sem negrito**, nome completo do anúncio (não headline inventada).
3. **Preço inteiro sem decimais**: `R$ 1.066`, `R$ 449`, `R$ 1.799`; quebrado com centavos: `R$ 233,53`.
4. **Sem** "caiu muito o preço", sem `De/Por`, sem "Link do Produto ⤵️", sem rodapé 🤖.
5. **Cupom em `🎟️ Cupom: X`** (não ⚠️).
6. **Link curto direto** (meli.la com sua etiqueta; Emipe usa domínio próprio — fora de escopo).
7. Grupo admin-only de ofertas (Radar Teste / Radar Teste #2 seguem o modelo).

## Exemplos do vídeo

- `🔥 Monitor Gamer AOC AGON CS2 25, 25 Pol…` + ℹ️ pix + `💵 R$ 1.066 (Pix)` + 🚚 Prime + `🎟️ PRIMEHOJE` + link
- `🔥 Placa Mae Msi Pro B840m-B…` + `💵 R$ 449` + `🎟️ MELHORDEHJ` + meli.la
- `🔥 (Parcelado) Console Nintendo Switch OLED…` + `💵 R$ 1.799` + `⭐ Em até 10x sem juros` + `🎟️ COMPRAAGORA` + link
