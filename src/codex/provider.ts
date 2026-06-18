import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';
import type { QueryOptions, QueryResult } from './types.js';

function findCodexBinary(): string {
  const envPath = process.env.CODEX_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const binRoot = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = readdirSync(binRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(binRoot, entry.name, 'codex.exe'))
      .filter(path => existsSync(path));
    if (candidates.length > 0) return candidates[0];
  } catch {
    // Fall through to PATH lookup.
  }

  return 'codex';
}

function imageArgs(images?: QueryOptions['images']): string[] {
  // The current bridge only has base64 image data at this point. Keep image
  // support explicit instead of silently writing many temp files here.
  if (!images?.length) return [];
  return [];
}

export async function codexQuery(options: QueryOptions): Promise<QueryResult> {
  const codexPath = findCodexBinary();
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '-C', options.cwd,
    '-s', 'danger-full-access',
    ...imageArgs(options.images),
  ];

  if (options.model) {
    args.push('-m', options.model);
  }

  const prompt = [
    options.systemPrompt,
    options.prompt,
  ].filter(Boolean).join('\n\n');

  logger.info('Starting Codex CLI query', {
    cwd: options.cwd,
    model: options.model,
    codexPath,
  });

  let child: ChildProcess;
  try {
    child = spawn(codexPath, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: '', sessionId: '', error: `Failed to spawn codex: ${msg}` };
  }

  child.stdin?.write(prompt);
  child.stdin?.end();

  const textParts: string[] = [];
  const stderrParts: string[] = [];
  let sessionId = '';
  let errorMessage: string | undefined;
  let settled = false;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      const partialText = textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId,
        error: partialText ? undefined : 'Codex query timed out after 60 minutes',
      });
    }, 60 * 60 * 1000);

    const onAbort = () => {
      child.kill('SIGTERM');
      finish({ text: textParts.join('\n').trim(), sessionId });
    };
    options.abortController?.signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderrParts.push(String(chunk));
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', line => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === 'thread.started' && event.thread_id) {
        sessionId = event.thread_id;
      }
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item?.type === 'agent_message' && item.text) {
          const text = String(item.text);
          textParts.push(text);
          if (options.onText) Promise.resolve(options.onText(text)).catch(() => {});
          if (options.onBlockEnd) Promise.resolve(options.onBlockEnd()).catch(() => {});
        }
        if (item?.type === 'message' && item.role === 'assistant') {
          const text = (item.content || [])
            .filter((part: any) => part.type === 'output_text')
            .map((part: any) => part.text || '')
            .join('');
          if (text) {
            textParts.push(text);
            if (options.onText) Promise.resolve(options.onText(text)).catch(() => {});
            if (options.onBlockEnd) Promise.resolve(options.onBlockEnd()).catch(() => {});
          }
        }
      }
      if (event.type === 'turn.failed') {
        errorMessage = event.error?.message || event.error || 'Codex turn failed';
      }
    });

    child.on('close', code => {
      clearTimeout(timeoutId);
      options.abortController?.signal.removeEventListener('abort', onAbort);
      const text = textParts.join('\n').trim();
      if (code !== 0 && !text && !errorMessage) {
        errorMessage = stderrParts.join('').trim() || `codex exited with code ${code}`;
      }
      logger.info('Codex CLI query completed', {
        sessionId,
        textLength: text.length,
        hasError: !!errorMessage,
      });
      finish({ text, sessionId, error: errorMessage });
    });

    child.on('error', err => {
      clearTimeout(timeoutId);
      options.abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId, error: `Failed to spawn codex: ${err.message}` });
    });
  });
}
