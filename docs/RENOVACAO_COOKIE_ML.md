# Manutenção do Cookie ML

## 📋 Problema Conhecido

O cookie `_mldataSessionId` do Mercado Livre **expira a cada 15-30 minutos**. Isso causa a mensagem `CREATELINK_SEM_URL` quando o sistema tenta converter links.

## 🔄 Soluções

### Opção 1: Renovação Manual (Recomendado para uso pontual)

1. **Acesse o hub de afiliados**:
   ```
   https://www.mercadolivre.com.br/afiliados
   ```

2. **Abrir DevTools** (F12) → Aba **Application** → **Cookies** → `https://www.mercadolivre.com.br`

3. **Copiar o valor** de `_mldataSessionId`

4. **Renovar cookie**:
   ```bash
   COOKIE_ML='_mldataSessionId=XXX' node scripts/maintain-cookie.mjs
   ```

### Opção 2: Teste Rápido de Conversão

```bash
COOKIE_ML='_mldataSessionId=XXX' \
  node scripts/test-conversion.mjs \
  "https://produto.mercadolivre.com.br/MLB-XXXXX"
```

### Opção 3: Automatização (Cron)

Para uso contínuo, configure um cron job que rode a cada 25 minutos:

```bash
# Adicionar ao crontab (crontab -e)
*/25 * * * * cd /caminho/do/projeto && /bin/bash -c 'COOKIE_ML="_mldataSessionId=XXX" && node scripts/maintain-cookie.mjs'
```

## 📊 Verificar Status

```bash
# Mostrar contas configuradas
cat data/contas.json | jq '.contas[] | {nome, tag}'

# Verificar quando o cookie expira (debug)
curl -s 'https://www.mercadolivre.com.br/gz/cart/v2/info/header' \
  -b '_mldataSessionId=XXX' | jq '.user'
```

## 🔧 Scripts Disponíveis

| Script | Função |
|--------|--------|
| `scripts/maintain-cookie.mjs` | Atualiza cookie em todas as contas |
| `scripts/test-conversion.mjs` | Testa conversão de link com cookie válido |
| `scripts/auto-renew-cookie.mjs` | Interface de renovação automática |

## 🛠️ Solução Alternativa: Conversor Externo

Se o cookie continua expirando rapidamente, configure `ML_CONVERSOR_URL` apontando para um bot que possa gerenciar a sessão (ex: bot do Telegram afiliado).

## 💡 Dicas

- **Tag afiliado**: `rm20261013081024219` (válida para todas as contas)
- **Produto teste MLB**: `MLB-27693851` (produto amplo, comissão variável)
- **Status do serviço**: http://localhost:8091 (panel de monitoramento)