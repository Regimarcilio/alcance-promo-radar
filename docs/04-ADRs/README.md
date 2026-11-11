# ADRs — Architecture Decision Records

Registros das decisões de arquitetura do **Alcance Promo Radar**. ADRs são **append-only**: cada
registro mantém o contexto da época; quando uma decisão é revista, cria-se um novo ADR em vez de
reescrever o antigo. O status indica se a decisão ainda vale no estado atual do código (v0.8.0).

> Última revisão do índice: 2026-10-22

| ADR | Assunto | Status atual |
| --- | --- | --- |
| [ADR-001](ADR-001-envio-whatsapp.md) | Envio WhatsApp: Evolution MVP + abstração para Cloud | Vigente (só Evolution/Baileys; provedor Cloud não implementado) |
| [ADR-002](ADR-002-ia-gateway.md) | IA via Gateway EngAI com approval, nunca direta | Histórica — a IA é **stub** hoje (RF-005 adiado); gateway real não integrado |
| [ADR-003](ADR-003-fonte-ml.md) | Fonte ML: Afilimax/Garimpei self-host + fallback manual | Histórica — Afilimax não integrado; a fonte real é scrap/HTML do ML |
| [ADR-004](ADR-004-hunter.md) | Hunter autônomo por categoria | Parcial — RF-016 implementado parcialmente |
| [ADR-005](ADR-005-auth-sessao-2fa.md) | Auth do painel: sessão em cookie + 2FA por celular | Vigente |
| [ADR-006](ADR-006-multi-numero-rotacao.md) | Multi-número: rodízio ponderado + principal × secundários | Vigente |
| [ADR-007](ADR-007-clientes-campanhas.md) | Clientes: contatos, listas e campanha com fila anti-bloqueio | Vigente |
| [ADR-008](ADR-008-ui-temas.md) | Painel: temas visuais e títulos editáveis por card | Vigente |
| [ADR-009](ADR-009-shopee-open-api.md) | Shopee: link de afiliado via Open API (`generateShortLink`) | Vigente (validação live pendente de credenciais) |
| [ADR-010](ADR-010-verificacao-celular-favoritos-ml.md) | Verificação de celular no 1º acesso + favoritos do ML | Vigente |

## Mapa ADR × requisitos

| ADR | RFs | RNs |
| --- | --- | --- |
| ADR-001 | RF-009, RF-034 | RN-011 |
| ADR-002 | RF-005 (adiado) | RN-005 |
| ADR-003 | RF-002, RF-016 | RN-008 |
| ADR-004 | RF-016 | — |
| ADR-005 | RF-036, RF-040, RF-041 | RN-017, RN-018 |
| ADR-006 | RF-042, RF-054 | RN-016 |
| ADR-007 | RF-045, RF-046, RF-047 | RN-019, RN-020, RN-021 |
| ADR-008 | RF-048, RF-049 | RN-022 |
| ADR-009 | RF-032 | RN-023 |
| ADR-010 | RF-036, RF-037 | RN-018 |

Fonte canônica dos RF/RN: [`../SRS-v0.4.md`](../SRS-v0.4.md). Índice geral de documentos:
[`../00-INDICE.md`](../00-INDICE.md).
