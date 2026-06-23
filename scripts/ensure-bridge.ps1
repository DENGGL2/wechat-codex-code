$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodePath = "C:\Program Files\nodejs\node.exe"
$logDir = Join-Path $env:USERPROFILE ".wechat-codex-code\logs"
$watchdogLog = Join-Path $logDir "bridge-watchdog.log"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-WatchdogLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffK"
  Add-Content -Path $watchdogLog -Value "$timestamp $Message"
}

function Show-BridgeNotification {
  param(
    [string]$Title,
    [string]$Message
  )

  try {
    Add-Type -AssemblyName System.Windows.Forms
    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Message
    $notifyIcon.Visible = $true
    $notifyIcon.ShowBalloonTip(8000)
    Start-Sleep -Seconds 9
    $notifyIcon.Dispose()
  } catch {
    Write-WatchdogLog "Notification failed: $($_.Exception.Message)"
  }
}

function Get-BridgeProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -match "dist[/\\]main\.js|dist/main\.js|dist\\main\.js"
    } |
    Select-Object -First 1
}

$bridgeProcess = Get-BridgeProcess

if ($bridgeProcess) {
  Write-WatchdogLog "Bridge already running pid=$($bridgeProcess.ProcessId)."
  exit 0
}

if (-not (Test-Path $nodePath)) {
  $message = "Node not found at $nodePath."
  Write-WatchdogLog $message
  Show-BridgeNotification "WeChat bridge offline" $message
  exit 1
}

if (-not (Test-Path (Join-Path $projectDir "dist\main.js"))) {
  $message = "Bridge entry not found under $projectDir."
  Write-WatchdogLog $message
  Show-BridgeNotification "WeChat bridge offline" $message
  exit 1
}

Start-Process -FilePath $nodePath -ArgumentList "dist/main.js" -WorkingDirectory $projectDir -WindowStyle Hidden
Start-Sleep -Seconds 10

$startedBridgeProcess = Get-BridgeProcess
if ($startedBridgeProcess) {
  Write-WatchdogLog "Bridge was not running; started pid=$($startedBridgeProcess.ProcessId) from $projectDir."
  exit 0
}

$message = "Codex is running, but the WeChat bridge did not start."
Write-WatchdogLog $message
Show-BridgeNotification "WeChat bridge offline" $message
exit 1
