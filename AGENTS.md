# AGENTS.md — padrão de trabalho dos agentes neste projeto

Este arquivo vale para todo agente (planmaster, protomaster, frontdev, master, etc.)
que trabalhe neste repositório. Complementa as instruções globais do opencode.

## 0. REGRA DE OURO — demanda aberta = resolução imediata e obrigatória (regra dura)

Abrir um chamado **é** a autorização e a ordem de resolver. Diagnosticar **não é
entregar**. Todo agente que receber uma demanda (defeito, bug, melhoria, feature,
"não está funcionando", "está travado", investigação) tem a **obrigatoriedade de
conduzi-la até a solução na mesma tarefa** — não apenas explicar o que aconteceu.

Regras:

1. **Diagnóstico é o começo, nunca o fim.** Terminar a resposta com "encontrei o
   problema", "o motivo é X" ou uma tabela de causas, sem aplicar a correção, é
   **entrega incompleta e proibida**.
2. **Corrija, valide e prove.** Para cada demanda: aplicar a correção → compilar
   (`npm run build`/equivalente) → executar/validar (build, teste, estado real em
   runtime, logs) → reportar a **evidência** de que resolveu (antes/depois,
   comando + saída, contagem, log). "Deve funcionar" não é evidência.
3. **Não transfira trabalho de volta sem esgotar o que é possível.** Não devolva ao
   usuário uma pergunta ou um "o que você prefere?" se a ação segura e reversível já
   podia ter sido executada. Execute o caminho seguro; pergunte só o que for
   irreversível ou depender de terceiros.
4. **Exceções legítimas para parar** (somente estas):
   - **Ação humana externa**: exige escanear QR de WhatsApp, credencial/segredo que
     só o dono tem, aprovação de terceiro. → Faça **tudo** o que der antes e diga
     exatamente e em 1 linha o que falta e onde.
   - **Ação destrutiva irreversível** (apagar dados/instâncias, `rm`, deploy em
     produção, cobrança): pedir OK **depois** de preparar e explicar o impacto.
   - **Ambiguidade real de requisito**: no máximo **1 rodada** de pergunta e então
     seguir com o padrão mais seguro, registrando a premissa.
5. **Bloqueio não é desculpa para entregar pela metade.** Se um item da demanda
   depende de externo, entregue o restante já corrigido e valide-o; deixe 1 item
   pendente claramente marcado com o que falta.
6. **Rastreio até o fechamento.** Demanda com issue/PR: só encerrar com AC
   atendido, validação registrada e `docs/dev-log.md` atualizado. Sem issue: a
   própria mensagem é o chamado e vale a mesma obrigação.
7. **Nada de "fiz e não sei se pegou".** Se a correção depende de deploy/restart
   para valer, **faça o deploy/restart** e confirme o efeito. Alterar arquivo que
   não entra em produção não é corrigir.

Resumo: **demanda aberta → diagnosticar → corrigir → validar → provar → registrar.**
Se não terminou, você não terminou — continue.

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

> **Atalho para defeito/correção (não se aplica a Regra 0):** bug, erro em runtime,
> travamento, envio falhando, regressão ou "não está funcionando" **não passam por
> protótipo**. Vão direto para diagnóstico → correção → validação → evidência,
> conforme a Seção 0. Protótipo/aprovação existe só para **trabalho visual novo**.

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
