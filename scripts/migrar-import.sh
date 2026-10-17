#!/usr/bin/env bash
# Importa o pacote de migração na máquina DESTINO (rede limpa).
# Uso (já dentro da pasta do projeto clonado):
#   ./scripts/migrar-import.sh /caminho/migracao-AAAAMMDD-HHMM.tar.gz.enc
set -euo pipefail
cd "$(dirname "$0")/.."

ENC="${1:?Uso: $0 /caminho/migracao-....tar.gz.enc}"
[ -f "$ENC" ] || { echo "ERRO: arquivo não encontrado: $ENC"; exit 1; }

TMPD="$(mktemp -d)"
cp "$ENC" "$TMPD/pacote.tar.gz.enc"

echo "Digite a senha da criptografia:"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$TMPD/pacote.tar.gz.enc" -out "$TMPD/pacote.tar.gz"
tar -xzf "$TMPD/pacote.tar.gz" -C "$TMPD"

[ -f "$TMPD/.env" ] || { echo "ERRO: pacote sem .env"; exit 1; }
cp "$TMPD/.env" .env
chmod 600 .env
mkdir -p data
[ -f "$TMPD/data/contas.json" ] && cp "$TMPD/data/contas.json" data/contas.json
[ -f "$TMPD/data/cestas.json" ] && cp "$TMPD/data/cestas.json" data/cestas.json
[ -f "$TMPD/data/envios.json" ] && cp "$TMPD/data/envios.json" data/envios.json
chmod 600 data/contas.json 2>/dev/null || true

echo "Ajuste os endereços para esta máquina (se necessário):"
grep -E "^(EVO_URL|EVO_SERVER_URL|EVO_HOST_PORT)" .env || true
echo
echo "OK. Próximo: docker compose up -d && npm install && npm run build && npm run manager &"
echo "Depois: npm start -- evo:qr  →  LIGA TUDO na tela."

rm -rf "$TMPD"
