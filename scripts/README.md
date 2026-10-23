# scripts/ — operação, backup e restore

Scripts operacionais do **alcance-promo-radar**. Nenhum deles é executado
automaticamente pelo CI ou pelo compose. Destrutivos exigem confirmação explícita.

## Backup

```bash
# destino default: $HOME/backups/alcance-promo-radar
./scripts/backup.sh

# destino explícito
./scripts/backup.sh /mnt/backup/alcance

# openssl (fallback): senha com >= 16 chars, preferindo arquivo 600
install -m 600 /dev/null "$HOME/.config/alcance-backup.pass"
openssl rand -base64 32 > "$HOME/.config/alcance-backup.pass"
BACKUP_PASSPHRASE_FILE="$HOME/.config/alcance-backup.pass" ./scripts/backup.sh

# age (recomendado): chave pública para cifrar, identidade separada para restaurar
export BACKUP_AGE_RECIPIENT="age1..."
./scripts/backup.sh
```

O pacote contém:

- `.env` (com permissão `600` dentro do tar);
- **todo** `data/` — JSONs e `data/midia/`;
- `pg/<db>.dump` (pg_dump custom da Evolution, quando o container existir);
- `MANIFEST.txt` com sha256 de cada arquivo.

Logs (`logs/`) **não** entram no backup. O `pg_dump` é automático quando
`BACKUP_PG=auto` (default) e o container `PG_CONTAINER` estiver rodando. Use
`BACKUP_PG=1` para tornar o dump obrigatório ou `0` para desativar.

### Cifra

- `BACKUP_ENCRYPTION=auto` usa **age** se houver `BACKUP_AGE_RECIPIENT` e o
  binário `age`; caso contrário usa openssl.
- openssl = **AES-256-CTR + HMAC-SHA256** (encrypt-then-MAC). O arquivo `.hmac`
  é obrigatório na restauração; o CTR sozinho não autentica.
- Guarde a passphrase ou a identidade age **fora** do servidor. Sem ela o
  pacote é inútil.

Retenção: `BACKUP_RETENTION_DAYS` (default 14; `0` desativa). Os arquivos são
gravados com `600` e o diretório novo com `700`.

## Restore

```bash
# confirmação obrigatória
RESTORE_CONFIRM=1 ./scripts/restore.sh /caminho/backup-....tar.gz.enc
RESTORE_CONFIRM=1 ./scripts/restore.sh /caminho/backup-....tar.gz.age
./scripts/restore.sh --latest --yes

# sem restaurar o banco
RESTORE_PG=0 RESTORE_CONFIRM=1 ./scripts/restore.sh --latest
```

Antes de sobrescrever, o script copia `data/` e `.env` atuais para
`${BACKUP_DIR:-$HOME/backups/alcance-promo-radar}/pre-restore/<timestamp>/`.
A restauração valida HMAC/age, caminhos do tar, symlinks/hardlinks, sha256 e
sintaxe dos JSONs **antes** de tocar em `data/`. Se a validação do pacote
falhar, o `data/` atual não é tocado.

`RESTORE_PG=auto` restaura o dump somente se `PG_CONTAINER` estiver rodando;
`1` obriga e falha se o container estiver parado; `0` ignora o banco.

## Migração entre máquinas

```bash
# origem
./scripts/migrar-export.sh /tmp
# destino (repo clonado)
RESTORE_CONFIRM=1 ./scripts/migrar-import.sh /caminho/migracao-....tar.gz.enc
```

Os dois scripts usam o mesmo formato de `backup.sh`/`restore.sh`; a diferença é
o prefixo (`migracao-`) e as mensagens de próximo passo.

## Operação diária

```bash
# validar o manager (após a rota /healthz existir no código)
curl -fsS http://127.0.0.1:8091/healthz

# logs com rotação (compose)
docker compose logs -f --tail=100 manager

# backup agendado (cron, exemplo 03:20)
20 3 * * * cd /caminho/alcance-promo-radar && \
  BACKUP_PASSPHRASE_FILE=/root/.config/alcance-backup.pass \
  ./scripts/backup.sh /mnt/backup/alcance >> /var/log/alcance-backup.log 2>&1
```

## Notas de segurança

- `MANAGER_BIND` default é `127.0.0.1`. Expor na LAN só com TLS/reverse proxy e
  `AUTH_COOKIE_SECURE=1`.
- `docker-compose.manager-novo.yml` usa volumes nomeados próprios; **não**
  compartilhe `./data` entre instâncias.
- Não versione `.env`, pacotes `.enc/.age` nem o diretório `pre-restore/`.
- O restore também restaura segredos antigos do `.env`: revise `EVO_URL`,
  `EVO_HOST_PORT`, `MANAGER_BIND` e `AUTH_COOKIE_SECURE` após importar.
