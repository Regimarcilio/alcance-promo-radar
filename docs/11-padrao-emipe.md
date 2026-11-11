# 11 — Padrão de mensagem Emipe (RN-001 v2 → v3)

> **RETRATO HISTÓRICO (v2).** Este documento registra o padrão observado no vídeo do grupo
> "#55 Emipe Promoções" e que **vigorou como RN-001 v2**. O template **atualmente implementado** é o
> **RN-001 v3**, descrito em [RN-001 v3 — estado real](#rn-001-v3--estado-real-fonte-srcwaformatterts)
> ao final do arquivo, com a fonte de verdade em `src/wa/formatter.ts`. Onde houver divergência, vale
> o v3.

> Fonte original: `movie/Screen_Recording_20261014_091405_WhatsApp.mp4`
> (grupo "#55 Emipe Promoções", 15s, 3 variantes). Substituiu o padrão
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

---

## RN-001 v3 — estado real (fonte: `src/wa/formatter.ts`)

O padrão do vídeo (v2) foi **revisto** para o modelo completo — o v3 **volta a exibir De/Por** e as
parcelas, mantendo a foto e o cupom. Fonte de verdade: `formatar()` em `src/wa/formatter.ts`.

### Template v3 (o que o código produz, linha a linha)

```
[marca]                        ← opcional: MARCA_HANDLE / MARCA_NOME / campo `marca`
                               ← (linha em branco)
🔥 {nome}
                               ← (linha em branco)
[ℹ️ {infoPix}]                 ← opcional; mais uma linha em branco
[~De R$ {precoDe}~]           ← só se precoDe existir (inteiro, com centavos via brl())
*Por R$ {precoPix} no Pix*
*Ou R$ {precoParc} em até {n}x*
                               ← (linha em branco)
[🚚 {frete}]                   ← opcional; mais uma linha em branco
[🎟️ Cupom: *{CUPOM}*]          ← opcional (uppercase); mais uma linha em branco
🛒 Link do Produto ⤵️
{link}
```

### Regras do v3 (fidelidade ao código)

1. **Título com 🔥, sem negrito forçado**; usa `nome` (título do anúncio).
2. **Preços usam `brl()`** → `R$ 1.066,00`, `R$ 233,53` (**sempre com centavos**). A função
   `brlCurto()` (inteiro sem centavos, como no v2) **existe no módulo mas não é usada** por
   `formatar()`.
3. **Parcelas**: `precoParc` vem do input; se ausente, é calculado como `precoPix * 1.11`
   (`+ (…).toFixed(2)`). `parcelas` default = **6**.
4. **Cupom** sempre em **caixa alta** (`cupom.toUpperCase()`) e em negrito no valor.
5. **Frete** nunca é inventado: só aparece se `frete` for informado.
6. **Marca** vem do campo `marca` do input; se `undefined`, cai no default
   `MARCA_HANDLE` + `MARCA_NOME` + `#anúncio` (omitida se nenhum dos dois existir).
7. **`headline` e `subtitulo`** continuam no `MensagemInput` (compatibilidade), mas **o formatter
   não os usa** — não há "caiu muito o preço" nem headline em negrito.
8. **Limite**: texto acima de **4096** caracteres lança `Error("MENSAGEM_LONGA")`.

### Divergências v2 → v3 (resumo)

| Ponto | v2 (vídeo) | v3 (código atual) |
| --- | --- | --- |
| De/Por | sem `De/Por` | **volta** `~De …~` + `*Por … no Pix*` |
| Parcelas | só se conhecido | **sempre** mostra `*Ou … em até Nx*` |
| Preço | inteiro sem centavos | `brl()` **com centavos** |
| Rodapé | sem 🤖 | sem 🤖 (mantido) |
| `🛒 Link do Produto ⤵️` | removido | **presente** |
| `headline`/`subtitulo` | — | campos existem, **ignorados** |
