#!/usr/bin/env bash
# ==========================================================================
# restore.sh — restaura um backup completo (data/ + .env + pg_dump opcional).
#
# Uso:
#   RESTORE_CONFIRM=1 ./scripts/restore.sh /caminho/backup-....tar.gz.enc
#   RESTORE_CONFIRM=1 ./scripts/restore.sh /caminho/backup-....tar.gz.age
#   RESTORE_CONFIRM=1 ./scripts/restore.sh --latest
#   ./scripts/restore.sh --latest --yes
#
# Segurança:
#   - exige confirmação explícita (RESTORE_CONFIRM=1 ou --yes);
#   - valida HMAC/age, caminhos do tar, symlinks, hashes sha256 e JSONs;
#   - salva o estado atual em <BACKUP_DIR>/pre-restore/<timestamp> antes de
#     sobrescrever data/ e .env (rollback manual documentado no fim).
#
# pg_dump: RESTORE_PG=auto (default; só se o container existir), 1 (obrigatório)
# ou 0 (ignorar). ATENÇÃO: a restauração do banco sobrescreve o destino.
# ==========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-backup.sh
source "$SCRIPT_DIR/lib-backup.sh"

usage() {
  cat >&2 <<'EOF'
Uso: restore.sh <arquivo.tar.gz.enc|.tar.gz.age|.tar.gz> [--yes]
     restore.sh --latest [--yes]
Confirmação: RESTORE_CONFIRM=1 ou --yes
EOF
  exit 2
}

ARCHIVE=""
LATEST=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --latest) LATEST=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage ;;
    *) ARCHIVE="$arg" ;;
  esac
done

if [ "$LATEST" = "1" ] || [ -z "$ARCHIVE" ]; then
  DEST="$(resolve_backup_dir "${BACKUP_DIR:-}")"
  ARCHIVE="$(latest_archive "$DEST")"
  [ -n "$ARCHIVE" ] || die "nenhum backup encontrado em $DEST."
  log "backup mais recente: $ARCHIVE"
fi

if [ -d "$ARCHIVE" ]; then
  ARCHIVE="$(latest_archive "$ARCHIVE")"
  [ -n "$ARCHIVE" ] || die "diretório sem backups."
fi
[ -f "$ARCHIVE" ] || die "arquivo não encontrado: $ARCHIVE"

if [ "$YES" != "1" ] && [ "${RESTORE_CONFIRM:-0}" != "1" ]; then
  cat >&2 <<EOF
RESTAURAÇÃO IRÁ SOBRESCREVER:
  - $ROOT/data  (todos os JSON + mídia)
  - $ROOT/.env
  - banco ${PG_DB} (se houver dump e o container ${PG_CONTAINER} estiver ativo)

O estado atual será salvo antes em:
  \${BACKUP_DIR:-...}/pre-restore/<timestamp>

Confirme com: RESTORE_CONFIRM=1 $0 "$ARCHIVE"
          ou: $0 "$ARCHIVE" --yes
EOF
  exit 3
fi

restore_archive "$ARCHIVE"
