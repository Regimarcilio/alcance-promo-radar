# 01 — Visão e Escopo — autoMensagemWhats [v0.2 HUNTER]

> Versão: 0.2 | Data: 2026-10-12 | Branch: `develop` | Autor: PLANMASTER
> Mudança v0.1→v0.2: sai o fluxo manual “colar URL → formatar”. Entra o **caçador autônomo por categoria**.
> Material: https://integrador-cedup.glide.page/dl/a400f7

## 1. Problema (revalidado com seu feedback)
O protótipo v0.1 provou que sabemos replicar a mensagem (ex. Orient MBSS1171), mas ainda exigia que o operador **achasse a oferta**. O gargalo real é garimpar. Operador perde horas varrendo ML.

Evidência base continua: `image/Screenshot_20261011_223512_WhatsApp.jpg` — agora lida como **exemplo de saída**, não de entrada.

## 2. Objetivo geral v0.2
A partir de **uma categoria a escolher** (ex. `Relógios`, `Fones Bluetooth`, `Smartwatch`, `Air Fryer`), o sistema **busca sozinho as oportunidades**, **gera as informações** (título, preços, cupom, link afiliado, copy) e **envia ao grupo**, tudo de forma automática (modo AUTO) ou semi-automática (modo REVISÃO).

## 3. Como funciona (fluxo hunter)
```
1. OP escolhe CATEGORIA + filtros (desconto mín, teto R$, só c/ cupom, avaliação mín)
2. SCHEDULER roda a cada Xh (ex. 2h, 8h-22h)
3. HUNTER busca Top 50 da categoria no ML → extrai preço/de/cupom/vendidos
4. SCORER ranqueia: % desconto + queda vs histórico + tem cupom + vendidos + avaliação
5. Top N (ex. 3) → ENRICH (link afiliado meli.la) → COPY (template+IA) → FORMAT
6. DISPATCH automático p/ grupo RADAR + log + anti-duplicidade (não reenvia mesmo MLB em 7 dias)
```

## 4. Objetivos / Sucesso v0.2
1. OP configura categoria 1 vez; sistema roda 7 dias sem intervenção.
2. ≥3 oportunidades/dia por categoria com desconto real ≥30% (validado vs preço De).
3. 0 duplicadas em 7 dias; 0 erro de preço/link.
4. Envio AUTO com taxa entrega 100% + log auditável (quando, porquê score).
5. Piloto: 1 categoria + 1 grupo, ≤10 msgs/dia (seguro anti-ban).

## 5. Escopo IN v0.2 (novo)
- Catálogo de categorias + filtros salvos (`categorias.json`).
- Hunter ML: search por categoria/termo + paginação + extração (Garimpei/Afilimax estendido).
- Histórico de preços (SQLite) para detectar **queda real** (não falso De).
- Scorer explicável (pesos configuráveis).
- Modo AUTO (envia sozinho se score ≥ corte) + modo REVISÃO (approval).
- Anti-duplicidade por `MLB-ID` + hash de preço.
- Scheduler cron + janela permitida + limite diário.
- Tudo do v0.1 mantido (formatter RN-001, preview, providers Evolution/Cloud, trace).

## 6. Escopo OUT
- Spam base fria, disparo noturno sem flag, multi-marketplace no MVP (só ML), fine-tune, app mobile.

## 7. Personas (atualizado)
| Persona | Nova jornada |
|---|---|
| OP curador | Escolhe `Relógios ⌚` + filtros → ativa AUTO → só acompanha log |
| ADM | Define corte score, limite/dia, janela; intervém só em exceção |
| Seguidor | Recebe só as melhores quedas, não enxurrada |

## 8. Restrições / Premissas novas
- Search ML em volume sofre rate-limit/bloqueio → cache 2h + backoff + rotação de cookie.
- Falso desconto (De inflado) → exigir histórico ≥3 coletas ou selo `OFERTA BOA` vs `QUEDA REAL`.
- AUTO total exige aceite explícito do dono (risco ban); padrão inicial = REVISÃO, evolui p/ AUTO.
- LGPD/ToS mantidos da v0.1.

## 9. Perguntas abertas v0.2
- [ ] Quais 3 categorias do piloto?
- [ ] Corte: desconto mín? Teto R$? Só com cupom?
- [ ] AUTO desde dia 1 ou REVISÃO 1 semana?
- [ ] Intervalo varredura e limite msgs/dia?
