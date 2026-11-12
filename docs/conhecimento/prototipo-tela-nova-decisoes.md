# Protótipo de tela nova: view nova + estados por seletor

## Decisões
Ao prototipar uma tela que entra no produto (issue #53 — view Mensageria do painel):

1. **View nova no menu lateral, sem redesenhar abas existentes.** As abas que já existem
   (Clientes, Monitor, Números, Rastreio) ficam intactas; a tela nova é item novo do menu,
   com badge de contagem (itens na DLQ), como as demais.
2. **Estados obrigatórios por seletor de cenário**, no topo da área de conteúdo — a forma
   mais barata de cobrir vazio / grande / erro / carregando / reprocessando sem multiplicar
   arquivos de protótipo. O seletor também funciona como legenda do que se está vendo.
3. **Dados fictícios nas formas reais dos payloads** (LGPD): os mesmos campos, tipos e
   motivos canônicos da API — nenhum campo inventado — e selo visível "dados fictícios".
4. **Motivo colorido carrega a decisão**: erro não transitório em vermelho (retry não
   resolve) e tentativas esgotadas em âmbar (retry pode resolver).
5. **Ações destrutivas e em lote com confirmação explícita e contagem exata**
   ("vai reprocessar 3 mensagens do tipo X"), pluralização correta em pt-BR
   ("1 mensagem" / "3 mensagens") e aviso de que não há como desfazer.
6. **Trilha de correlação em gaveta lateral, não modal**: é consulta — não deve bloquear a
   tabela; e o rodapé da gaveta mantém a ação de reparo ao alcance (consultar → reparar).
7. **Ações em lote agem sobre o filtro visível** (tipo + busca) — nunca às cegas.

## Evidência
- Issue #53 / PR #64 — `docs/prototipos/mensageria/` (8 cenários, ações exercitadas de ponta
  a ponta).

## Regra geral
Protótipo que mostra **decisão** do operador precisa mostrar também **o custo da decisão**
(confirmação, contagem, aviso de irreversibilidade).
