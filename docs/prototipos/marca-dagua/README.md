# Protótipo — marca d'água da mascote nas fotos enviadas

> Status: **aprovado e implementado** em 2026-10-27 (working tree, sem commit).
> Tema: aplicar `image/Guru dos Achadinhos.png` como selo em cada foto repassada
> pelo monitor (origem e anúncio).

## Arquivos

| Arquivo | O que mostra |
|---|---|
| `comparativo.jpg` | Antes × depois na mesma foto (referência principal). |
| `foto-1080-selo-18.jpg` | Foto 1080×1080 com selo de 194 px. |
| `foto-400-selo-18.jpg` | Foto 400×400 com selo de 72 px. |
| `foto-100-selo-18.jpg` | Miniatura 100×100 com selo de 42 px (limite de 42% da largura). |
| `foto-real-implementacao.jpg` | Saída real do `src/wa/marca-dagua.ts` no host. |
| `foto-container.jpg` | Saída real gerada dentro do container `automensagem_manager`. |

A foto de exemplo é uma captura real de `data/midia/` (produto de grupo de
origem), usada só como referência visual.

## Parâmetros do protótipo

- Escala: **18% da largura** da foto.
- Limites: mínimo **72 px**, máximo **220 px**; em imagens muito pequenas o selo
  é limitado a **42%** da largura para não cobrir tudo.
- Posição: **canto inferior direito**.
- Margem: **~3,5%** da largura, limitada entre 8 e 36 px.
- Cantos arredondados: raio de **18%** do selo.
- Fundo: branco original mantido (o selo parece um cartão/adesivo arredondado).
- Opacidade: 1,0.
- Saída: JPEG qualidade 86.

## Implementação (feita em 2026-10-27)

1. `sharp` 0.35.5 adicionado ao projeto.
2. `src/wa/marca-dagua.ts` com a mesma matemática acima; mascote normalizada em
   cache (512 px) e selo cacheado por tamanho/opacidade.
3. Aplicado em `enviarMidia()` **antes** do `comRetry`, cobrindo foto da origem,
   foto do anúncio e data URI.
4. **Fail-open**: arquivo ausente, buffer inválido, formato não suportado ou
   `MONITOR_MARCA=0` devolvem a foto original (nunca bloqueia a oferta).
5. Config:
   - `MONITOR_MARCA=1`
   - `MONITOR_MARCA_ARQUIVO=image/Guru dos Achadinhos.png`
   - `MONITOR_MARCA_ESCALA=0.18`
   - `MONITOR_MARCA_OPACIDADE=1`
6. `Dockerfile.manager` copia `image/` para o runtime.

Latência medida: ~0,3–0,9 s por foto 1080×1080 no host e ~0,6 s no container
(CPU limitada a 1). Como a fila libera 1 envio a cada 60 s, não há impacto no
ritmo.

## Observações

- O PNG tem fundo branco; para um recorte transparente é necessário fornecer
  uma versão com alpha.
- GIF animado e vídeo não recebem o selo; envios só de texto não mudam.
- O protótipo foi gerado com ImageMagick só como referência visual; a
  produção usa `sharp` com os mesmos parâmetros.

## Pendência

- `image/Guru dos Achadinhos.png` está **untracked** no git. Precisa ser
  versionado (ou fornecido no build) antes de um build em CI, porque o
  `Dockerfile.manager` copia `image/`.
