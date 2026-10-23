#!/usr/bin/env bash
# ==========================================================================
# migrar-export.sh — exporta o pacote de migração (COM segredos) para FORA
# do repositório.
#
# Uso:
#   ./scripts/migrar-export.sh [diretório-destino]
#
# Inclui TODO o data/ (JSON + midia/), .env e, quando o container existir,
# pg_dump custom da Evolution. Cifra com age (recomendado) ou
# AES-256-CTR + HMAC-SHA256 (openssl). Retenção configurável.
#
# NUNCA commite os pacotes (o .gitignore cobre migracao-*).
# Equivalente operacional: ./scripts/backup.sh (mesmo formato).
# ==========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-backup.sh
source "$SCRIPT_DIR/lib-backup.sh"

export BACKUP_PREFIX="${BACKUP_PREFIX:-migracao}"

DEST="${1:-${BACKUP_DIR:-/tmp}}"
ARCHIVE="$(create_backup "$DEST" "$BACKUP_PREFIX")"

cat <<EOF

Migração exportada: $ARCHIVE
Conteúdo: .env + data/ (JSON e midia/) + MANIFEST.txt + pg_dump (se disponível)

No destino:
  1) clone o repositório e entre na pasta;
  2) ./scripts/migrar-import.sh "$ARCHIVE"
  3) revise EVO_URL/EVO_HOST_PORT no .env;
  4) docker compose up -d --build

Leve APENAS o pacote cifrado. Apague-o da origem após transferir com segurança.
Guarde a senha/identidade age fora do servidor de origem e do destino.
EOF
