#!/usr/bin/env bash
# Smoke test do manager: sobe o servidor com estado temporário, valida o gate
# default-deny e derruba. Não toca em data/ real e não inicia workers de fila.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/manager/server.js ]; then
  echo "dist/manager/server.js ausente. Rode: npm run build" >&2
  exit 1
fi

TMP="$(mktemp -d)"
PORT="${SMOKE_PORT:-18099}"
export ALCANCE_DATA_DIR="$TMP"
export ALCANCE_SMOKE=1
export MANAGER_PORT="$PORT"
export SESSION_SECRET="$(openssl rand -hex 32)"
export WEBHOOK_KEY="$(openssl rand -hex 16)"
export AUTH_PASSWORD="smoke-pass-123"
export AUTH_TTL_HORAS=1
export AUTH_IDLE_MIN=5
export AUTH_COOKIE_SECURE=0

PID=""
cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

node scripts/auth-user.mjs admin >/dev/null

node dist/manager/server.js >"$TMP/server.log" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/login"; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "manager encerrou durante o boot:" >&2
    cat "$TMP/server.log" >&2
    exit 1
  fi
  sleep 0.1
done

check() {
  local esperado="$1" url="$2" metodo="${3:-GET}" code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X "$metodo" "http://127.0.0.1:$PORT$url")"
  if [ "$code" != "$esperado" ]; then
    echo "FAIL $metodo $url: esperado $esperado, obtido $code" >&2
    cat "$TMP/server.log" >&2
    exit 1
  fi
  echo "ok $metodo $url -> $code"
}

check 200 /login
check 302 /
check 401 /api/contas
check 401 /api/webhook/evolution POST
check 404 /rota-inexistente

echo "smoke manager OK (porta $PORT)"
