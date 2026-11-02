# AGENTS.md — padrão de trabalho dos agentes neste projeto

Este arquivo vale para todo agente (planmaster, protomaster, frontdev, master, etc.)
que trabalhe neste repositório. Complementa as instruções globais do opencode.

## 1. Protótipos ficam DENTRO do projeto (regra dura)

Todo protótipo criado — HTML, wireframe, mockup, imagem, comparação antes/depois,
screenshot de referência, diagrama visual — deve ser salvo em:

```
docs/prototipos/<slug-do-tema>/
```

- **Nunca** em `/tmp`, `~`, `data/`, `logs/` ou fora do workspace do projeto.
- Se precisar gerar fora por velocidade (ex.: arquivo temporário), **mova para
  `docs/prototipos/<slug>/` antes de encerrar a tarefa** e apague o temporário.
- Cada pasta de protótipo deve ter um `README.md` com:
  - objetivo e status (`rascunho`, `aguardando aprovação`, `aprovado`, `implementado`);
  - lista dos arquivos e o que cada um mostra;
  - parâmetros usados (dimensões, posição, cores, fontes, etc.);
  - como abrir/visualizar;
  - decisões e pendências.
- Nomes descritivos e sem espaços: `opcao-1.html`, `comparativo.jpg`,
  `foto-1080-selo-18.jpg`, `mobile.png`.
- O protótipo aprovado é a referência de implementação; divergência exige
  atualização do protótipo ou justificativa registrada.

## 2. Fluxo mínimo antes de codar

1. Ler `docs/SRS-v0.4.md` (ou a spec da demanda) e o `docs/00-INDICE.md`.
2. Criar/atualizar o protótipo em `docs/prototipos/<slug>/` quando a demanda
   tiver interface, arte ou resultado visual.
3. Obter aprovação do usuário sobre o protótipo.
4. Só então implementar, testar e atualizar o `docs/dev-log.md`.

## 3. Git e entrega

- Trabalho na branch de demanda; nunca commitar direto em `main`/`master`.
- Conventional Commits em pt-BR (`feat(ui): ...`, `docs(proto): ...`).
- DoD: critério de aceite atendido + testes verdes + `kalimaster-sast` limpo +
  entrada no `docs/dev-log.md`.

## 4. Organização de artefatos

| Tipo | Onde |
|---|---|
| Protótipos (HTML, imagens, comparações) | `docs/prototipos/<slug>/` |
| Documentação e decisões | `docs/` e `docs/04-ADRs/` |
| Estado de runtime (fila, mídia, dedup) | `data/` (não versionar) |
| Logs | `logs/` (não versionar) |
| Código-fonte | `src/` |
