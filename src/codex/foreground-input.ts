import { spawn } from 'node:child_process';

export interface ForegroundInputResult {
  ok: boolean;
  title?: string;
  error?: string;
}

function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

export async function pasteIntoForegroundCodex(text: string): Promise<ForegroundInputResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: '没有可输入的内容。' };
  }

  const encoded = Buffer.from(trimmed, 'utf16le').toString('base64');
  const script = `
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $hwnd = [Win32]::GetForegroundWindow()
  $builder = New-Object System.Text.StringBuilder 512
  [void][Win32]::GetWindowText($hwnd, $builder, $builder.Capacity)
  $title = $builder.ToString()
  [uint32]$pid = 0
  [void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
  $processName = ''
  try {
    $processName = [Diagnostics.Process]::GetProcessById([int]$pid).ProcessName
  } catch {}
  if ($title -notmatch '(?i)codex' -and $processName -notmatch '(?i)^codex$') {
    Write-Output (@{ ok = $false; title = $title; process = $processName; error = '前台窗口不是 Codex' } | ConvertTo-Json -Compress)
    exit 0
  }
  $bytes = [Convert]::FromBase64String($env:WCC_CODEX_INPUT_B64)
  $text = [System.Text.Encoding]::Unicode.GetString($bytes)
  Set-Clipboard -Value $text
  $shell = New-Object -ComObject WScript.Shell
  Start-Sleep -Milliseconds 120
  [void]$shell.SendKeys('^v')
  Start-Sleep -Milliseconds 120
  Write-Output (@{ ok = $true; title = $title; process = $processName } | ConvertTo-Json -Compress)
} catch {
  Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 0
}
`;

  const result = await runPowerShell(script, {
    ...process.env,
    WCC_CODEX_INPUT_B64: encoded,
  });

  const output = result.stdout.trim();
  if (output) {
    try {
      return JSON.parse(output) as ForegroundInputResult;
    } catch {
      return { ok: false, error: output };
    }
  }
  return {
    ok: false,
    error: result.stderr.trim() || `PowerShell exited with code ${result.code}`,
  };
}
