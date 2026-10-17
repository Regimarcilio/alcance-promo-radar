#!/usr/bin/env bash
# Exporta o pacote de migração (COM segredos) para FORA do repo.
# Uso: ./scripts/migrar-export.sh [destino]
# Gera: migracao-AAAAMMDD-HHMM.tar.gz + .enc (criptografado, levar este)
# NUNCA commite estes arquivos (já estão no .gitignore).
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${1:-/tmp}"
STAMP="$(date +%Y%m%d-%H%M)"
BASE="migracao-${STAMP}"
TMPD="$(mktemp -d)"

[ -f .env ] || { echo "ERRO: .env não existe. Nada a exportar."; exit 1; }

cp .env "$TMPD/.env"
mkdir -p "$TMPD/data"
for f in contas.json cestas.json envios.json; do
  [ -f "data/$f" ] && cp "data/$f" "$TMPD/data/$f"
done
# envios.json vai junto para o dedup não reenviar o que já saiu daqui

tar -czf "${DEST}/${BASE}.tar.gz" -C "$TMPD" .env data
echo "Pacote: ${DEST}/${BASE}.tar.gz"
echo "Conteúdo (nomes, sem valores):"
tar -tzf "${DEST}/${BASE}.tar.gz"

echo
echo "Criptografando (escolha uma senha FORTE e anote)..."
openssl enc -aes-256-cbc -salt -pbkdf2 -in "${DEST}/${BASE}.tar.gz" -out "${DEST}/${BASE}.tar.gz.enc"
shred -u "${DEST}/${BASE}.tar.gz" 2>/dev/null || rm -f "${DEST}/${BASE}.tar.gz"
echo "Leve APENAS este arquivo: ${DEST}/${BASE}.tar.gz.enc"
echo "Apague o .enc da origem após transferir."

rm -rf "$TMPD"
