#!/usr/bin/env bash
# ==========================================================================
# migrar-import.sh — importa o pacote de migração na máquina DESTINO.
#
# Uso (já dentro da pasta do projeto clonado):
#   RESTORE_CONFIRM=1 ./scripts/migrar-import.sh /caminho/migracao-....tar.gz.enc
#   ./scripts/migrar-import.sh /caminho/migracao-....tar.gz.age --yes
#
# Restaura TODO o data/ (JSON + midia/) e o .env, valida HMAC/age, hashes e
# JSONs, e opcionalmente o pg_dump (RESTORE_PG=auto|1|0). O estado atual é
# salvo antes em <BACKUP_DIR>/pre-restore/<timestamp>.
# ==========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-backup.sh
source "$SCRIPT_DIR/lib-backup.sh"

ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] || die "Uso: $0 /caminho/migracao-....tar.gz.{enc,age} [--yes]"
shift || true
[ -f "$ARCHIVE" ] || die "arquivo não encontrado: $ARCHIVE"

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    *) die "argumento desconhecido: $arg" ;;
  esac
done

if [ "$YES" != "1" ] && [ "${RESTORE_CONFIRM:-0}" != "1" ]; then
  cat >&2 <<EOF
A importação sobrescreve $ROOT/data e $ROOT/.env (e o banco ${PG_DB}, se houver
dump e o container ${PG_CONTAINER} estiver ativo). O estado atual será salvo
antes em \${BACKUP_DIR:-...}/pre-restore/<timestamp>.

Confirme com: RESTORE_CONFIRM=1 $0 "$ARCHIVE"
          ou: $0 "$ARCHIVE" --yes
EOF
  exit 3
fi

restore_archive "$ARCHIVE"

cat <<EOF

Importação concluída. Ajuste endereços desta máquina no .env, se necessário:
  grep -E "^(EVO_URL|EVO_SERVER_URL|EVO_HOST_PORT|MANAGER_BIND)" .env || true

Próximos passos:
  docker compose up -d --build
  curl -fsS http://127.0.0.1:\${MANAGER_PORT:-8091}/healthz
  # depois abra o painel e clique em START (PILOTO_AUTORELIGA=0 por segurança)
EOF
