#!/usr/bin/env bash
# ==========================================================================
# backup.sh — backup operacional completo do alcance-promo-radar.
#
# Inclui: .env, TODO o data/ (JSON + midia/) e, opcionalmente, pg_dump da
# Evolution. Criptografa com age (recomendado) ou AES-256-CTR + HMAC-SHA256.
#
# Uso:
#   ./scripts/backup.sh [diretório-destino]
#
# Configuração (exporte no shell; não são lidos do .env):
#   BACKUP_DIR, BACKUP_RETENTION_DAYS, BACKUP_ENCRYPTION,
#   BACKUP_PASSPHRASE (openssl) OU BACKUP_AGE_RECIPIENT (age),
#   BACKUP_PG=auto|1|0, PG_CONTAINER, EVO_DB_USER, EVO_DB_NAME.
#
# O pacote gerado é o único artefato necessário para o DR. Guarde a senha /
# identidade age em local separado do servidor.
# ==========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-backup.sh
source "$SCRIPT_DIR/lib-backup.sh"

export BACKUP_PREFIX="${BACKUP_PREFIX:-backup}"

DEST="${1:-${BACKUP_DIR:-}}"
ARCHIVE="$(create_backup "$DEST" "$BACKUP_PREFIX")"

printf '\nBackup OK: %s\n' "$ARCHIVE"
printf 'Restaure com: ./scripts/restore.sh %q\n' "$ARCHIVE"
printf 'Retenção aplicada: %s dias (BACKUP_RETENTION_DAYS; 0 desativa).\n' "$BACKUP_RETENTION_DAYS"
