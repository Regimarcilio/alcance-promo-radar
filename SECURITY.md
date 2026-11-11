# Política de Segurança

## Reportar uma Vazamento

Por favor, **NÃO abra issues públicas** para vazamentos de segurança. Reporte diretamente para o mantenedor através do e-mail ou formulário de contato indicado no repositório.

## Principais Medidas de Segurança

### Credenciais
- **NUNCA** versionar o arquivo `.env` ou qualquer arquivo com credenciais
- Todos os segredos devem ser configurados via variáveis de ambiente
- O `.env.example` serve apenas como referência de estrutura

### Autenticação
- O painel utiliza autenticação por código WhatsApp no primeiro acesso
- Sessões são armazenadas em `data/auth-users.json` com permissão `0600`
- Rate-limit de reenvio de código: 3 por hora por IP
- Sessão é amarrada a IP mascarado (/24) e User-Agent

### Headers de Segurança
O painel já implementa:
- CSP (Content Security Policy)
- `referrer-policy: strict-origin-when-cross-origin`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Permissions-Policy` restringindo recursos avançados

### Rate Limiting
- Endpoints sensíveis têm limites por IP
- Webhook verifica `WEBHOOK_KEY` em header
- `/api/auth/login` protegido contra força bruta

### Docker Security
- Imagens rodam como usuário `node` (não root)
- npm/corepack removidos do runtime para reduzir superfície de ataque
- Dockerfile multi-stage para minimizar tamanho da imagem

### Produção Recomendada
- **OBRIGATÓRIO**: usar TLS via Caddy ou nginx
- Configurar firewall para bloquear portas internas
- Usar `docker-compose.production.yml` para deploy real

## Checklist de Deploy Seguro

```bash
# 1. Configure .env com credenciais reais
cp .env.example .env
# Editar .env com valores do ambiente

# 2. Crie usuário admin
npm run auth:user -- admin --telefone 5511999999999

# 3. Build e teste local
npm run build
npm test

# 4. Deploy com docker-compose.production.yml
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d

# 5. Verifique logs
docker compose logs -f manager
```

## Vazamento Conhecido

Se você encontrar uma vulnerabilidade, por favor reporte antes de abrir um issue público. Agradecemos sua colaboração!