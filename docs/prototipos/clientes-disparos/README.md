# Protótipo — Clientes: lista salva + mídia + grid de disparos

**Status**: aguardando aprovação.

## Objetivo

Na tela **Clientes**, abaixo da seleção atual:

1. escolher uma **lista salva** como destino;
2. escrever a mensagem, com **link opcional**;
3. escolher **imagem ou vídeo** do computador (upload);
4. enviar — cada disparo vira uma linha no **grid de disparos**, com CRUD:
   editar (enquanto pendente), duplicar/reenviar e excluir.

## Arquivo

| Arquivo | Mostra |
|---|---|
| `proposta.html` | protótipo navegável com dados de exemplo: upload com preview, envio, edição, duplicação e exclusão |

## Como abrir

```bash
xdg-open docs/prototipos/clientes-disparos/proposta.html
```

## Parâmetros

- Layout herda o painel: fundo `--bg`, painéis `--panel`, bordas `--border`, fonte `system-ui 12.5–14px`.
- Grid: colunas **Quando · Lista · Mensagem · Mídia · Status · Envios · Ações**.
- Status: `PENDENTE` (amarelo), `ENVIANDO` (azul), `CONCLUIDO` (verde), `PARCIAL` (laranja), `ERRO` (vermelho), `CANCELADO` (cinza).
- Upload aceita `png/jpeg/webp/gif/mp4` até **16 MB**; preview usa `<img>` ou `<video>` antes de enviar.
- Ações: ✏️ editar (só pendente), ⧉ duplicar/reenviar, 🗑 excluir.

## Regras de negócio propostas

1. **Editar** só é permitido enquanto o disparo não começou a sair; depois, a ação correta é **duplicar**.
2. **Excluir** um disparo pendente remove da fila os contatos que ainda não receberam (o que já saiu não volta).
3. **Duplicar** cria um novo disparo `PENDENTE` com a mesma mensagem/link/mídia e reenfileira todos os contatos da lista.
4. Mídia é copiada para `data/midia/<uuid>.<ext>` (mesma pasta segura usada pelo monitor); o envio vai em base64 com `mediatype` `image` ou `video`.
5. Disparos antigos (feitos antes desta tela) não têm registro retroativo.

## Decisões

- Destino = **lista salva** (não a seleção avulsa), conforme demanda. A seleção avulsa continua funcionando como hoje.
- Grid na própria tela Clientes, abaixo do formulário.
- CRUD completo: ler (grid + auto-refresh 15s), criar (envio), editar (pendente), excluir, duplicar.

## Pendências / riscos

- Vídeo: WhatsApp impõe limite prático (~16 MB); acima disso o envio deve falhar de forma visível no status `ERRO`.
- Um disparo "PARCIAL" acontece se alguns contatos falharem; o grid mostra `enviados/total` + falhas.
