# FH -- Freenet Website Publisher (PowerShell)
# Builds the Vite bundle and publishes to Freenet via fdev CLI

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Fisherman's Horizon -- Freenet Publish  " -ForegroundColor Cyan
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
    Write-Error "Build fallita. Impossibile procedere con la pubblicazione."
    exit $LASTEXITCODE
}

# 4. Check existing keys
Write-Host "`nControllo chiavi Freenet..." -ForegroundColor Yellow
$keyList = & fdev website list 2>&1 | Out-String

if ($keyList -match "(?i)\bFH\b") {
    Write-Host "Chiave FH trovata. Pubblicazione su Freenet (fdev website publish)..." -ForegroundColor Green
    & fdev website publish dist --key FH
} else {
    Write-Host "Inizializzazione nuova chiave FH (fdev website init FH)..." -ForegroundColor Yellow
    & fdev website init FH
    Write-Host "Pubblicazione iniziale (fdev website publish)..." -ForegroundColor Green
    & fdev website publish dist --key FH
}

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "Pubblicazione completata con successo!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

