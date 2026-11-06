#!/usr/bin/env bash
# FH — Freenet Website Publisher (Bash)

set -euo pipefail

echo "=========================================="
echo "   Fisherman's Horizon — Freenet Publish  "
echo "=========================================="

if ! command -v fdev &> /dev/null; then
    echo "Errore: fdev CLI non trovato nel PATH." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "Cartella progetto: $PROJECT_ROOT"

echo "Compilazione bundle UI in corso (npm run build)..."
npm run build

KEY_LIST=$(fdev website list 2>&1 || true)

if echo "$KEY_LIST" | grep -qi "\bFH\b"; then
    echo "Chiave 'FH' trovata. Pubblicazione su Freenet (fdev website publish)..."
    fdev website publish dist --key FH
else
    echo "Inizializzazione nuova chiave 'FH' (fdev website init FH)..."
    fdev website init FH
    echo "Pubblicazione iniziale (fdev website publish)..."
    fdev website publish dist --key FH
fi

echo "=========================================="
echo "Pubblicazione completata!"
echo "=========================================="

