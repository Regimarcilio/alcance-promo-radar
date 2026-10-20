# Protótipos de login — Alcance

Três telas de autenticação navegáveis para o painel **Alcance**, sem framework, sem build e sem CDN. Todas usam a mesma conta demo e o mesmo painel simulado (sidebar + 2 cards + botão Sair).

**Conta demo:** usuário `admin` · senha `alcance`  
Qualquer outra combinação exibe erro com shake.

## Como abrir

Na raiz do repositório:

```bash
cd docs/prototipos/auth
python3 -m http.server 8100
```

Abra **http://localhost:8100/** (hub). A porta 8099 fica livre para o painel real.

Alternativa sem servidor:

```bash
xdg-open docs/prototipos/auth/index.html
```

Tudo é autocontido (CSS/JS inline), então o duplo clique também funciona. A preferência de paleta é salva em `localStorage` e compartilhada entre as telas.

## As três opções

| Arquivo | Conceito | Animação principal | Sucesso |
|---|---|---|---|
| `opcao-1.html` | **Sala de controle** — split-screen, gradiente vivo com orbs e cartão de login | Entrada em stagger, orbs em movimento lento, shake no erro | Selo com check desenhado antes de revelar o painel |
| `opcao-2.html` | **Esteira de ofertas** — marquee diagonal de mini-ofertas e cartão translúcido | Marquee infinito, parallax suave no mouse, shake no erro | Wipe do cartão expandindo para o painel |
| `opcao-3.html` | **Radar** — fundo escuro com sweep, anéis e blips | Radar girando, inputs underline, glow no botão, shake no erro | Ripple/pulso que “escaneia” a tela e abre o painel |

### Opção 1 — Sala de controle

**Prós:** identidade mais próxima do painel claro atual; hierarquia forte; selo de sucesso dá feedback claro; layout split-screen funciona bem em desktop e empilha no mobile.  
**Contras:** ocupa mais altura no mobile por causa do bloco de marca; o gradiente vivo pode competir com o formulário em telas pequenas.  
**Quando escolher:** se a prioridade é transmitir “monitor de ofertas” com clareza e manter a linguagem visual do produto.

### Opção 2 — Esteira de ofertas

**Prós:** comunica o produto pelo movimento (ofertas circulando); cartão de vidro dá foco sem esconder o fundo; wipe é uma transição memorável; parallax é sutil.  
**Contras:** marquee + blur custam mais GPU em celular modesto; fundo pode distrair quem tem baixa visão; a estética é mais “showcase” que ferramenta.  
**Quando escolher:** se o login precisa vender a proposta do Alcance já na primeira tela.

### Opção 3 — Radar

**Prós:** identidade mais marcante e técnica; inputs minimalistas; ripple de sucesso combina com o conceito; contraste alto no escuro.  
**Contras:** destoa do painel claro real; exige atenção à acessibilidade (foco, contraste de textos secundários); tema escuro não é o padrão do produto hoje.  
**Quando escolher:** se o produto vai ganhar um modo escuro ou se a marca quer um posicionamento mais “monitor/alertas”.

## O que avaliar

1. **Identidade** — parece o Alcance? Conversa com a sidebar, cards e paletas atuais?
2. **Animação** — tem propósito, roda fluida e não atrapalha o login? Teste com `prefers-reduced-motion` ativo.
3. **Clareza** — usuário entende onde digitar, vê a dica demo e chega ao CTA em menos de ~15 s?
4. **Acessibilidade** — navegação só por `Tab`, foco visível, labels, mensagem de erro anunciada, contraste AA e layout em 390 px.
5. **Transição** — o sucesso parece recompensa e o “Sair” devolve ao login sem quebrar o estado?
6. **Paletas** — avalie verde (default), laranja, marrom e cacau. O contraste e a hierarquia se mantêm?
   > Nota: o protótipo traz 4 das 6 paletas do painel; a implementação final usará as 6 (incluindo areia e grafite) e a mesma chave `paleta`.

### Roteiro rápido (2 min por opção)

1. Entrar com `admin` / `alcance` e observar a transição até o painel.
2. Sair e errar a senha de propósito (ver shake + mensagem).
3. Alternar as quatro paletas no seletor do topo.
4. Repetir em 390 px e navegar apenas com teclado.

## Acessibilidade implementada

- `<label>` associado a cada campo e `autocomplete` correto.
- Botão mostrar/ocultar senha com `aria-pressed`, `aria-controls` e rótulo dinâmico.
- Erro com `role="alert"` + `aria-live="polite"` e `aria-invalid` nos campos.
- Foco visível em todos os controles; foco gerenciado ao abrir/sair do painel.
- Estado de carregamento com `aria-busy` e botão desabilitado.
- `prefers-reduced-motion` desliga animações, marquee, radar e parallax.
- Layout testado em desktop e 390 px; fundo decorativo com `aria-hidden`.

## Limitações

- Autenticação e dados são **mock**; não há backend, sessão real ou integração com `src/manager/server.ts`.
- Credenciais fixas (`admin` / `alcance`) — não usar como referência de segurança.
- O painel pós-login é apenas ilustrativo (sidebar, 2 métricas e lista).
- A paleta escolhida persiste em `localStorage`; não há endpoint de preferência.
- `backdrop-filter` (Opção 2) tem fallback de fundo sólido em navegadores sem suporte.
- Fontes do sistema; nenhuma imagem externa é carregada.

## Próximo passo

Escolher uma opção → registrar o delta em `docs/proto/` → `@stylemaster` para o acabamento visual → `@frontdev` para espelhar no painel real → `@qamaster` para transformar o roteiro em Playwright.
