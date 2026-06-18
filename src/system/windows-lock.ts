import { execFile } from 'node:child_process';

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export async function isWindowsLocked(): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  try {
    const output = await runPowerShell(
      "(Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Select-Object -First 1) -ne $null",
    );
    return /^true$/i.test(output);
  } catch {
    return false;
  }
}

