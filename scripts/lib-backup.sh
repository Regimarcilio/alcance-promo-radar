#!/usr/bin/env bash
# ==========================================================================
# lib-backup.sh — funções comuns de backup/restore do alcance-promo-radar.
#
# Formato do pacote:
#   <prefixo>-AAAAMMDD-HHMMSS-PID.tar.gz.enc(.hmac)   [openssl]
#   <prefixo>-AAAAMMDD-HHMMSS-PID.tar.gz.age          [age]
#
# Conteúdo:
#   .env                  (perms 600 no pacote)
#   data/                 (TODOS os JSON + data/midia/)
#   pg/<db>.dump          (opcional, pg_dump custom via docker)
#   MANIFEST.txt           (hashes sha256 de cada arquivo)
#
# Cifra:
#   - age é o modo recomendado (chave assimétrica; identidade fora do servidor).
#   - fallback openssl: AES-256-CTR + HMAC-SHA256 (encrypt-then-MAC).
#     O CTR sozinho NÃO autentica; o .hmac é obrigatório na restauração.
#
# Este arquivo é uma biblioteca: não execute diretamente.
# ==========================================================================

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERRO: os scripts de backup exigem bash." >&2
  exit 1
fi
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_STAMP="$(date +%Y%m%d-%H%M%S)-$$"
BACKUP_PREFIX="${BACKUP_PREFIX:-migracao}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_ENCRYPTION="${BACKUP_ENCRYPTION:-auto}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
PG_CONTAINER="${PG_CONTAINER:-evolution_pg_radar}"
PG_USER="${EVO_DB_USER:-radar}"
PG_DB="${EVO_DB_NAME:-evolution}"
PG_ADMIN_USER="${PG_ADMIN_USER:-postgres}"
BACKUP_PG="${BACKUP_PG:-auto}"
RESTORE_PG="${RESTORE_PG:-auto}"

TMP_DIRS=()
cleanup_tmp_dirs() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
}
trap cleanup_tmp_dirs EXIT

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >&2; }
warn() { printf '[%s] AVISO: %s\n' "$(date '+%F %T')" "$*" >&2; }
die()  { printf '[%s] ERRO: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "comando obrigatório não encontrado: $1"
}

new_tmp() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/alcance-backup.XXXXXX")"
  chmod 700 "$d"
  TMP_DIRS+=("$d")
  printf '%s\n' "$d"
}

resolve_backup_dir() {
  local d="${1:-${BACKUP_DIR:-${HOME:-/var/tmp}/backups/alcance-promo-radar}}" created=0
  if [ ! -d "$d" ]; then
    mkdir -p "$d"
    created=1
  fi
  # Nunca alterar permissões de diretório pré-existente (ex.: /tmp).
  [ "$created" = "1" ] && chmod 700 "$d"
  (cd "$d" && pwd -P)
}

load_passphrase() {
  if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -n "$BACKUP_PASSPHRASE_FILE" ]; then
    [ -r "$BACKUP_PASSPHRASE_FILE" ] \
      || die "BACKUP_PASSPHRASE_FILE não é legível: $BACKUP_PASSPHRASE_FILE"
    # $(cat) remove apenas newlines finais; não use `tr -d` para não mutilar a senha.
    BACKUP_PASSPHRASE="$(cat "$BACKUP_PASSPHRASE_FILE")"
  fi
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    export BACKUP_PASSPHRASE
    [ "${#BACKUP_PASSPHRASE}" -ge 16 ] || die "BACKUP_PASSPHRASE deve ter ao menos 16 caracteres."
    return 0
  fi
  [ -r /dev/tty ] || die "BACKUP_PASSPHRASE não definido e não há TTY para perguntar."
  local p=""
  read -r -s -p "Senha do backup (mín. 16 chars): " p < /dev/tty
  printf '\n' >&2
  [ "${#p}" -ge 16 ] || die "senha curta (mín. 16)."
  BACKUP_PASSPHRASE="$p"
  export BACKUP_PASSPHRASE
}

use_age() {
  case "$BACKUP_ENCRYPTION" in
    age) return 0 ;;
    openssl) return 1 ;;
    auto)
      [ -n "${BACKUP_AGE_RECIPIENT:-}" ] && command -v age >/dev/null 2>&1
      return $?
      ;;
    *) die "BACKUP_ENCRYPTION inválido: $BACKUP_ENCRYPTION (use auto|age|openssl)" ;;
  esac
}

mac_key_hex() {
  # HMAC-SHA256 com chave derivada da passphrase. O modo recomendado é age;
  # aqui o objetivo é autenticar o ciphertext do fallback openssl.
  printf '%s' "${BACKUP_PASSPHRASE}:alcance-backup-v2" \
    | openssl dgst -sha256 -binary \
    | od -An -v -tx1 | tr -d ' \n'
}

encrypt_archive() {
  local plain="$1" base="$2"
  if use_age; then
    command -v age >/dev/null 2>&1 || die "BACKUP_ENCRYPTION=age, mas o binário age não existe."
    [ -n "${BACKUP_AGE_RECIPIENT:-}" ] || die "BACKUP_AGE_RECIPIENT não definido (chave pública age1...)."
    local out="${base}.age"
    age -e -r "$BACKUP_AGE_RECIPIENT" -o "$out" "$plain"
    chmod 600 "$out"
    printf '%s\n' "$out"
    return 0
  fi

  need_cmd openssl
  load_passphrase
  local out="${base}.enc" hmac="${base}.enc.hmac" key
  key="$(mac_key_hex)"
  openssl enc -aes-256-ctr -pbkdf2 -iter 600000 -salt \
    -pass env:BACKUP_PASSPHRASE -in "$plain" -out "$out"
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key" "$out" \
    | awk '{print $NF}' > "$hmac"
  chmod 600 "$out" "$hmac"
  printf '%s\n' "$out"
}

verify_openssl_hmac() {
  local cipher="$1" hmac="$2" key expected actual
  [ -f "$hmac" ] || die "HMAC ausente: $hmac (pacote openssl não autenticado)."
  load_passphrase
  key="$(mac_key_hex)"
  expected="$(tr -d '[:space:]' < "$hmac")"
  actual="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key" "$cipher" | awk '{print $NF}')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] \
    || die "HMAC inválido: pacote corrompido ou senha errada."
}

decrypt_archive() {
  local archive="$1" outdir="$2" out
  case "$archive" in
    *.age)
      need_cmd age
      out="${outdir}/pacote.tar.gz"
      if [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
        [ -f "$BACKUP_AGE_IDENTITY" ] || die "BACKUP_AGE_IDENTITY não encontrado: $BACKUP_AGE_IDENTITY"
        age -d -i "$BACKUP_AGE_IDENTITY" -o "$out" "$archive"
      else
        [ -r /dev/tty ] || die "Defina BACKUP_AGE_IDENTITY para restaurar pacote age sem TTY."
        age -d -o "$out" "$archive"
      fi
      printf '%s\n' "$out"
      ;;
    *.enc)
      verify_openssl_hmac "$archive" "${archive}.hmac"
      out="${outdir}/pacote.tar.gz"
      openssl enc -d -aes-256-ctr -pbkdf2 -iter 600000 -salt \
        -pass env:BACKUP_PASSPHRASE -in "$archive" -out "$out"
      printf '%s\n' "$out"
      ;;
    *.tar.gz|*.tgz)
      warn "Restaurando pacote SEM criptografia (extensão $archive). Prefira .enc/.age."
      out="${outdir}/pacote.tar.gz"
      cp "$archive" "$out"
      printf '%s\n' "$out"
      ;;
    *)
      die "Formato não reconhecido: $archive (esperado .age, .enc ou .tar.gz)."
      ;;
  esac
}

prune_backups() {
  local dest="$1" prefix="$2" days="$3"
  [ "$days" -gt 0 ] 2>/dev/null || return 0
  find "$dest" -maxdepth 1 -type f \
    \( -name "${prefix}-*.enc" -o -name "${prefix}-*.age" -o -name "${prefix}-*.hmac" \) \
    -mtime +"$days" -print -delete 2>/dev/null || true
}

pg_container_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" = "true" ]
}

pg_required() {
  case "$BACKUP_PG" in
    1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

pg_disabled() {
  case "$BACKUP_PG" in
    0|false|no) return 0 ;;
    *) return 1 ;;
  esac
}

create_backup() {
  local dest prefix tmp payload pgfile="" final
  dest="$(resolve_backup_dir "${1:-}")"
  prefix="${2:-$BACKUP_PREFIX}"

  [ -f "$ROOT/.env" ] || die ".env não existe em $ROOT; nada sensível/incompleto a exportar."
  [ -d "$ROOT/data" ] || die "data/ não existe em $ROOT; backup incompleto seria perigoso."

  tmp="$(new_tmp)"
  payload="$tmp/payload"
  mkdir -p "$payload/data"

  log "copiando .env e data/ (inclui midia/)..."
  install -m 600 "$ROOT/.env" "$payload/.env"
  cp -a "$ROOT/data/." "$payload/data/"

  if pg_disabled; then
    log "pg_dump desativado (BACKUP_PG=0)."
  elif pg_required && ! pg_container_running; then
    die "BACKUP_PG=1, mas o container $PG_CONTAINER não está rodando."
  elif pg_container_running; then
    mkdir -p "$payload/pg"
    pgfile="pg/${PG_DB}.dump"
    log "gerando pg_dump do banco ${PG_DB} via docker exec ${PG_CONTAINER}..."
    if ! docker exec "$PG_CONTAINER" pg_dump \
          -U "$PG_USER" -d "$PG_DB" --format=custom --no-owner --no-privileges \
          > "$payload/$pgfile" 2> "$tmp/pg.err"; then
      sed 's/^/  /' "$tmp/pg.err" >&2 || true
      rm -f "$payload/$pgfile"
      if pg_required; then
        die "pg_dump falhou (BACKUP_PG=1). Corrija antes de continuar."
      fi
      warn "pg_dump falhou; backup seguirá sem o banco (BACKUP_PG=auto)."
      pgfile=""
    elif [ ! -s "$payload/$pgfile" ]; then
      rm -f "$payload/$pgfile"
      pgfile=""
      warn "pg_dump vazio; seguindo sem o dump."
    fi
  else
    log "container $PG_CONTAINER ausente/parado; backup sem pg_dump (BACKUP_PG=auto)."
  fi

  log "gerando MANIFEST.txt com sha256..."
  (
    cd "$payload"
    {
      echo "format=alcance-backup-v2"
      echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "host=$(hostname 2>/dev/null || echo desconhecido)"
      echo "git_commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo n/a)"
      echo "pg_dump=${pgfile:-nenhum}"
      echo "files:"
      find . -type f ! -name MANIFEST.txt -print0 \
        | sort -z \
        | xargs -0 sha256sum
    } > MANIFEST.txt
  )

  local plain="$tmp/${prefix}-${RUN_STAMP}.tar.gz"
  log "compactando..."
  tar -czf "$plain" -C "$payload" .
  chmod 600 "$plain"

  log "criptografando ($(use_age && echo age || echo openssl))..."
  final="$(encrypt_archive "$plain" "$dest/${prefix}-${RUN_STAMP}")"
  rm -f "$plain"

  prune_backups "$dest" "$prefix" "$BACKUP_RETENTION_DAYS"

  log "OK: $final ($(du -h "$final" | awk '{print $1}'))"
  log "guarde a senha/identidade FORA deste servidor; sem ela o pacote é inútil."
  printf '%s\n' "$final"
}

validate_payload() {
  local payload="$1" f
  [ -f "$payload/MANIFEST.txt" ] || die "pacote sem MANIFEST.txt."
  [ -f "$payload/.env" ] || die "pacote sem .env."
  [ -d "$payload/data" ] || die "pacote sem data/."

  log "validando hashes do MANIFEST..."
  (cd "$payload" && sha256sum --quiet -c MANIFEST.txt) \
    || die "checksum divergente; pacote corrompido."

  log "validando JSONs de data/..."
  if command -v node >/dev/null 2>&1; then
    while IFS= read -r -d '' f; do
      node -e 'const fs=require("fs");JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' "$f" \
        || die "JSON inválido: ${f#"$payload"/}"
    done < <(find "$payload/data" -type f -name '*.json' -print0)
  else
    warn "node não encontrado; validação sintática de JSON ignorada."
  fi

  [ -d "$payload/data/midia" ] || warn "data/midia/ não existe no pacote (pode ser normal se nunca houve mídia)."
  grep -qE '^SESSION_SECRET=.{16,}' "$payload/.env" \
    || warn "SESSION_SECRET ausente/curto no .env restaurado."
  grep -qE '^WEBHOOK_KEY=.{16,}' "$payload/.env" \
    || warn "WEBHOOK_KEY ausente/curto no .env restaurado."
}

extract_and_validate() {
  local tarfile="$1" outdir="$2" list="$outdir/tar.list" payload="$outdir/payload"
  mkdir -p "$payload"

  tar -tzf "$tarfile" > "$list"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$list"; then
    die "tar contém caminho absoluto ou ../ — abortando."
  fi
  # Rejeita symlink/hardlink ANTES de extrair (evita escape do diretório de
  # restauração via link malicioso seguido de escrita).
  if tar -tvzf "$tarfile" | awk 'substr($1,1,1) ~ /[lh]/ {found=1} END{exit(found?0:1)}'; then
    die "pacote contém symlink/hardlink; abortando por segurança."
  fi
  # --no-same-owner: restaura como o usuário atual, não como root do pacote.
  tar -xzf "$tarfile" --no-same-owner -C "$payload"
  if find "$payload" -type l -print -quit | grep -q .; then
    die "pacote contém symlink; abortando por segurança."
  fi
  validate_payload "$payload"
  printf '%s\n' "$payload"
}

restore_pg_dump() {
  local payload="$1" dump="$payload/pg/${PG_DB}.dump"
  [ -d "$payload/pg" ] || return 0
  [ -f "$dump" ] || { warn "diretório pg/ sem ${PG_DB}.dump; banco não será restaurado."; return 0; }

  case "$RESTORE_PG" in
    0|false|no)
      log "RESTORE_PG=0: dump do Postgres ignorado."
      return 0
      ;;
    1|true|yes)
      pg_container_running || die "RESTORE_PG=1, mas o container $PG_CONTAINER não está rodando."
      ;;
    *)
      if ! pg_container_running; then
        warn "container $PG_CONTAINER ausente/parado; dump do Postgres NÃO restaurado."
        return 0
      fi
      ;;
  esac

  [[ "$PG_DB" =~ ^[A-Za-z0-9_]+$ ]] || die "nome de banco inválido: $PG_DB"
  [[ "$PG_ADMIN_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "PG_ADMIN_USER inválido: $PG_ADMIN_USER"

  log "restaurando Postgres (${PG_DB}) via docker exec ${PG_CONTAINER}..."
  if ! docker exec "$PG_CONTAINER" psql -U "$PG_ADMIN_USER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -qx 1; then
    docker exec "$PG_CONTAINER" createdb -U "$PG_ADMIN_USER" "$PG_DB"
  fi
  docker exec -i "$PG_CONTAINER" pg_restore \
    -U "$PG_ADMIN_USER" -d "$PG_DB" \
    --clean --if-exists --no-owner --no-privileges --exit-on-error < "$dump"
  log "Postgres restaurado."
}

restore_archive() {
  local archive="$1" tmp tarfile payload safety
  [ -f "$archive" ] || die "arquivo não encontrado: $archive"
  tmp="$(new_tmp)"

  log "verificando/descriptografando $archive..."
  tarfile="$(decrypt_archive "$archive" "$tmp")"
  payload="$(extract_and_validate "$tarfile" "$tmp")"

  # Snapshot do estado atual antes de sobrescrever (idempotência + rollback).
  # Fica FORA do repo para não haver risco de commitar .env/segredos.
  safety="$(resolve_backup_dir "${BACKUP_SAFETY_DIR:-${BACKUP_DIR:-${HOME:-/var/tmp}/backups/alcance-promo-radar}}/pre-restore}")/${RUN_STAMP}"
  mkdir -p "$safety"
  if [ -d "$ROOT/data" ]; then
    cp -a "$ROOT/data" "$safety/data"
  fi
  if [ -f "$ROOT/.env" ]; then
    cp -a "$ROOT/.env" "$safety/.env"
  fi
  chmod 700 "$safety"
  log "estado anterior salvo em $safety"

  log "restaurando data/ e .env..."
  rm -rf "$ROOT/data"
  cp -a "$payload/data" "$ROOT/data"
  chmod -R u+rwX,go-rwx "$ROOT/data"
  install -m 600 "$payload/.env" "$ROOT/.env"

  restore_pg_dump "$payload"

  log "OK: restauração concluída a partir de $archive"
  log "revise $ROOT/.env (EVO_URL/EVO_HOST_PORT) antes de subir os containers."
  log "rollback: data anterior em $safety/data e env em $safety/.env"
}

latest_archive() {
  local dir="$1"
  [ -d "$dir" ] || die "diretório de backup não existe: $dir"
  find "$dir" -maxdepth 1 -type f \( -name '*.enc' -o -name '*.age' -o -name '*.tar.gz' \) \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | head -n1 | cut -d' ' -f2-
}
