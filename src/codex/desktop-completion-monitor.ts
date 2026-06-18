import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

import type { AccountData } from '../wechat/accounts.js';
import type { createSender } from '../wechat/send.js';
import type { createSessionStore, Session } from '../session.js';
import { logger } from '../logger.js';
import { isWindowsLocked } from '../system/windows-lock.js';

type Sender = ReturnType<typeof createSender>;
type SessionStore = ReturnType<typeof createSessionStore>;

interface CompletionEvent {
  id: number;
  threadId: string;
  title: string;
  cwd: string;
}

interface MonitorOptions {
  account: AccountData;
  session: Session;
  sessionStore: SessionStore;
  sender: Sender;
  getContextToken: () => string;
  isBridgeThread: (threadId: string) => boolean;
}

const CODEX_HOME = join(homedir(), '.codex');
const LOG_DB = join(CODEX_HOME, 'logs_2.sqlite');
const STATE_DB = join(CODEX_HOME, 'state_5.sqlite');
const POLL_MS = 15_000;

function runPython(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      ['-c', code],
      { windowsHide: true, timeout: 10_000 },
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

async function getLatestLogId(): Promise<number> {
  if (!existsSync(LOG_DB)) return 0;
  const out = await runPython([
    'import sqlite3',
    `con=sqlite3.connect(${JSON.stringify(LOG_DB)})`,
    "row=con.execute('select coalesce(max(id),0) from logs').fetchone()",
    'print(row[0] if row else 0)',
  ].join('\n'));
  return Number(out) || 0;
}

async function readCompletionEvents(afterId: number): Promise<CompletionEvent[]> {
  if (!existsSync(LOG_DB) || !existsSync(STATE_DB)) return [];

  const out = await runPython([
    'import sqlite3, json, re',
    `log_db=${JSON.stringify(LOG_DB)}`,
    `state_db=${JSON.stringify(STATE_DB)}`,
    `after_id=${afterId}`,
    'log=sqlite3.connect(log_db)',
    'state=sqlite3.connect(state_db)',
    "rows=log.execute(\"select id, feedback_log_body from logs where id > ? and feedback_log_body like '%response.completed%' order by id asc limit 100\", (after_id,)).fetchall()",
    'events=[]',
    'seen=set()',
    'for row_id, body in rows:',
    "    ids=re.findall(r'(?:conversation\\\\.id|thread\\\\.id|thread_id)=([0-9a-f-]{36})', body or '')",
    '    if not ids: continue',
    '    thread_id=ids[0]',
    '    if thread_id in seen: continue',
    '    seen.add(thread_id)',
    "    info=state.execute('select title, cwd from threads where id=?', (thread_id,)).fetchone()",
    "    title=(info[0] if info else thread_id) or thread_id",
    "    cwd=(info[1] if info else '') or ''",
    "    events.append({'id': row_id, 'threadId': thread_id, 'title': title, 'cwd': cwd})",
    'print(json.dumps(events, ensure_ascii=False))',
  ].join('\n'));

  if (!out) return [];
  return JSON.parse(out) as CompletionEvent[];
}

function buildDesktopCompletionMessage(event: CompletionEvent): string {
  const title = event.title.length > 80 ? `${event.title.slice(0, 79)}...` : event.title;
  return `Codex 对话完成：${title}`;
}

export function startCodexDesktopCompletionMonitor(options: MonitorOptions): () => void {
  if (process.platform !== 'win32') return () => {};
  if (!isPythonAvailable()) return () => {};

  let stopped = false;
  let lastLogId = 0;
  let running = false;

  async function poll(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      if (!lastLogId) {
        lastLogId = await getLatestLogId();
        return;
      }

      const events = await readCompletionEvents(lastLogId);
      if (events.length > 0) {
        lastLogId = Math.max(lastLogId, ...events.map(event => event.id));
      }

      for (const event of events) {
        if (options.isBridgeThread(event.threadId)) continue;
        if (!await isWindowsLocked()) continue;

        const summary = buildDesktopCompletionMessage(event);
        options.session.lastCompletionContext = {
          userText: `Codex Desktop thread: ${event.title}`,
          prompt: `Codex Desktop thread ${event.threadId}`,
          resultSummary: summary,
          fromUserId: options.account.userId || '',
          contextToken: options.getContextToken(),
          completedAt: Date.now(),
          provider: 'codex',
          sessionId: event.threadId,
        };
        options.sessionStore.save(options.account.accountId, options.session);

        if (options.account.userId) {
          await options.sender.sendText(options.account.userId, options.getContextToken(), summary);
        }
      }
    } catch (err) {
      logger.warn('Codex desktop completion monitor failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  }

  getLatestLogId().then(id => { lastLogId = id; }).catch(() => {});
  const timer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function isPythonAvailable(): boolean {
  const result = spawnSync('python', ['--version'], { windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
}


