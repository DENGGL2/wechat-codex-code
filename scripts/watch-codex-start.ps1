$ErrorActionPreference = "Stop"

$startBridgeScript = Join-Path $PSScriptRoot "start-bridge-if-codex.ps1"
$logDir = Join-Path $env:USERPROFILE ".wechat-codex-code\logs"
$watchLog = Join-Path $logDir "codex-start-watch.log"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-WatchLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffK"
  Add-Content -Path $watchLog -Value "$timestamp $Message"
}

function Start-BridgeForCodex {
  try {
    & $startBridgeScript
    Write-WatchLog "Codex detected; bridge ensure script executed."
  } catch {
    Write-WatchLog "Failed to ensure bridge: $($_.Exception.Message)"
  }
}

if (Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Select-Object -First 1) {
  Start-BridgeForCodex
}

$query = "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'Codex.exe'"
Register-WmiEvent -Query $query -SourceIdentifier "WechatCodexBridgeCodexStart" | Out-Null
Write-WatchLog "Codex start watcher is running."

while ($true) {
  Wait-Event -SourceIdentifier "WechatCodexBridgeCodexStart" | Out-Null
  Remove-Event -SourceIdentifier "WechatCodexBridgeCodexStart" -ErrorAction SilentlyContinue
  Start-BridgeForCodex
}
