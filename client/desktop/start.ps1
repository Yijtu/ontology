# Launcher for the Ontology Core desktop client.
#
# Keep this file ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as the system ANSI code
# page unless the file has a UTF-8 BOM, so non-ASCII text can be misdecoded and even swallow a
# closing quote (a real parse failure we hit). ASCII cannot be misread by any host.
#
# Double-click start.cmd. This script checks Node/pnpm, installs dependencies on first run, compiles,
# and launches Electron. On failure the window stays open with the reason.
$ErrorActionPreference = 'Stop'

function Stop-WithMessage([string]$message) {
  Write-Host ''
  Write-Host "Startup failed: $message" -ForegroundColor Red
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

try {
  Set-Location -LiteralPath $PSScriptRoot

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithMessage 'Node.js was not found. Install Node.js 22+ and reopen the terminal.'
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Stop-WithMessage 'pnpm was not found. Run: npm install -g pnpm'
  }

  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'First run: installing dependencies (downloads Electron, may take a few minutes)...' -ForegroundColor Cyan
    pnpm install
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Dependency installation failed. Check the network and retry.' }
  }

  Write-Host 'Compiling the desktop client...' -ForegroundColor Cyan
  pnpm run build
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Compilation failed. See the errors above.' }

  Write-Host 'Starting the Ontology Core desktop client...' -ForegroundColor Cyan
  Write-Host 'First launch asks for the server address. Local demo: http://127.0.0.1:3001 with an empty token.'
  pnpm exec electron .
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Electron exited with code $LASTEXITCODE." }
}
catch {
  Stop-WithMessage $_.Exception.Message
}
