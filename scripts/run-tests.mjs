import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = join(process.cwd(), 'dist', 'tests');
const files = readdirSync(testDir)
  .filter(file => file.endsWith('.test.js'))
  .map(file => join(testDir, file));

if (files.length === 0) {
  console.error('No compiled test files found under dist/tests.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  windowsHide: true,
});

process.exit(result.status ?? 1);
