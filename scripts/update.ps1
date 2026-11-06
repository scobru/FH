# FH -- Freenet Website Updater (PowerShell)
# Builds the Vite bundle and updates the site on Freenet via fdev CLI

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Fisherman's Horizon -- Freenet Update   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Check if fdev is installed
if (-not (Get-Command fdev -ErrorAction SilentlyContinue)) {
    Write-Error "fdev CLI non trovato nel PATH. Installa o aggiungi Freenet bin al PATH."
    exit 1
}

# 2. Change directory to FH project root
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

Write-Host "`nCartella progetto: $projectRoot" -ForegroundColor Gray

# 3. Build UI
Write-Host "`nCompilazione bundle UI in corso (npm run build)..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build fallita. Impossibile procedere con l'aggiornamento."
    exit $LASTEXITCODE
}

# 4. Update website
Write-Host "`nAggiornamento sito su Freenet (fdev website update dist --key FH)..." -ForegroundColor Green
& fdev website update dist --key FH

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "Aggiornamento completato con successo!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

