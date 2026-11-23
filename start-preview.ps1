param(
    [int]$Port = 4174
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notlike "*\WindowsApps\*") {
        $python = $command.Source
    } else {
        throw "Python was not found. Install Python 3.12 and create the project environment with: python -m venv .venv"
    }
}

$env:APP_ENV = "development"
$env:SEED_DEMO_USERS = "1"
$env:ENABLE_BACKGROUND_WORKER = "1"
$env:PORT = [string]$Port

Write-Host "Starting Liftline at http://127.0.0.1:$Port/"
Write-Host "Demo account password: Liftline-Demo-2026!"
& $python (Join-Path $root "app.py")
exit $LASTEXITCODE
