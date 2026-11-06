#!/usr/bin/env bash
# FH — Freenet Website Updater (Bash)

set -euo pipefail

echo "=========================================="
echo "   Fisherman's Horizon — Freenet Update   "
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

echo "Aggiornamento sito su Freenet (fdev website update)..."
fdev website update dist --key FH

echo "=========================================="
echo "Aggiornamento completato!"
echo "=========================================="

