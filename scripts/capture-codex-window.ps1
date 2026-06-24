param(
  [string]$OutputPath = "D:\CodexWork\wechat-acceptance\codex-window-screenshot.png"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CodexWindowCapture {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
'@

$codexWindow = Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $codexWindow) {
  throw "No visible Codex window was found."
}

$rect = New-Object CodexWindowCapture+RECT
[CodexWindowCapture]::GetWindowRect($codexWindow.MainWindowHandle, [ref]$rect) | Out-Null

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 200 -or $height -lt 200) {
  throw "Codex window is too small to capture: ${width}x${height}."
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$ok = [CodexWindowCapture]::PrintWindow($codexWindow.MainWindowHandle, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

if (-not $ok) {
  $bitmap.Dispose()
  throw "PrintWindow failed for Codex window."
}

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Get-Item $OutputPath | Select-Object FullName, Length, LastWriteTime
Write-Output "window=$($codexWindow.MainWindowTitle) size=${width}x${height}"
