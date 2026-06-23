$ErrorActionPreference = "Stop"

$codexProcess = Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $codexProcess) {
  exit 0
}

& (Join-Path $PSScriptRoot "ensure-bridge.ps1")
