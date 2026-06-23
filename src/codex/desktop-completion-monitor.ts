import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';

import type { AccountData } from '../wechat/accounts.js';
import type { createSender } from '../wechat/send.js';
import type { createSessionStore, Session } from '../session.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../constants.js';
import { isWindowsLocked } from '../system/windows-lock.js';

type Sender = ReturnType<typeof createSender>;
type SessionStore = ReturnType<typeof createSessionStore>;

interface CompletionEvent {
  id: number;
  threadId: string;
  title: string;
  cwd: string;
  preview: string;
  firstUserMessage: string;
  rolloutPath: string;
  lastAssistantMessage: string;
}

interface CompletionPushContent {
  title: string;
  summary: string;
}

interface MonitorOptions {
  account: AccountData;
  session: Session;
  sessionStore: SessionStore;
  sender: Sender;
  getContextToken: () => string;
  isBridgeThread: (threadId: string) => boolean;
  shouldIgnoreThread?: (event: CompletionEvent) => boolean;
}

const CODEX_HOME = join(homedir(), '.codex');
const LOG_DB = join(CODEX_HOME, 'logs_2.sqlite');
const STATE_DB = join(CODEX_HOME, 'state_5.sqlite');
const MONITOR_STATE_PATH = join(DATA_DIR, 'codex-desktop-completion-monitor.json');
const POLL_MS = 15_000;
const SAME_THREAD_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MonitorState {
  lastLogId?: number;
  notifiedThreadIds?: string[];
}

function loadMonitorState(): MonitorState {
  try {
    if (!existsSync(MONITOR_STATE_PATH)) return {};
    return JSON.parse(readFileSync(MONITOR_STATE_PATH, 'utf-8')) as MonitorState;
  } catch {
    return {};
  }
}

function saveMonitorState(state: MonitorState): void {
  mkdirSync(dirname(MONITOR_STATE_PATH), { recursive: true });
  writeFileSync(MONITOR_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

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
    "    ids=re.findall(r'(?:conversation\\.id|thread\\.id|thread_id)=([0-9a-f-]{36})', body or '')",
    '    if not ids: continue',
    '    thread_id=ids[0]',
    '    if thread_id in seen: continue',
    '    seen.add(thread_id)',
    "    info=state.execute('select title, cwd, preview, first_user_message, rollout_path from threads where id=?', (thread_id,)).fetchone()",
    "    title=(info[0] if info else thread_id) or thread_id",
    "    cwd=(info[1] if info else '') or ''",
    "    preview=(info[2] if info else '') or ''",
    "    first_user=(info[3] if info else '') or ''",
    "    rollout=(info[4] if info else '') or ''",
    "    last=''",
    "    if rollout:",
    "        try:",
    "            from collections import deque",
    "            with open(rollout.replace('\\\\\\\\?\\\\',''), 'r', encoding='utf-8', errors='ignore') as f:",
    "                tail=list(deque(f, maxlen=240))",
    "            for line in reversed(tail):",
    "                try: item=json.loads(line)",
    "                except Exception: continue",
    "                payload=item.get('payload') or {}",
    "                if item.get('type')=='event_msg' and payload.get('type')=='task_complete':",
    "                    last=payload.get('last_agent_message') or ''",
    "                    break",
    "                if item.get('type')=='response_item' and payload.get('type')=='message' and payload.get('role')=='assistant':",
    "                    parts=[]",
    "                    for c in payload.get('content') or []:",
    "                        if isinstance(c, dict) and c.get('type') in ('output_text','text'): parts.append(c.get('text') or '')",
    "                    if parts:",
    "                        last='\\n'.join(parts)",
    "                        break",
    "        except Exception:",
    "            last=''",
    "    events.append({'id': row_id, 'threadId': thread_id, 'title': title, 'cwd': cwd, 'preview': preview, 'firstUserMessage': first_user, 'rolloutPath': rollout, 'lastAssistantMessage': last})",
    'print(json.dumps(events, ensure_ascii=False))',
  ].join('\n'));

  if (!out) return [];
  return JSON.parse(out) as CompletionEvent[];
}


function stripSkillMarkdown(text: string): string {
  return text
    .replace(/\[\$[\w-]+\]\([^)]+\)\s*/g, '')
    .replace(/^\$[\w-]+\s*/g, '')
    .trim();
}

function isLikelyGeneratedContentTitle(text: string): boolean {
  const cleaned = stripSkillMarkdown(text);
  return cleaned.length > 120
    || /(?:^|\s)(?:下面是|以下是|Traceback|import |function |const |class |核心目标|重点内容|参考来源|整体课题结构)/.test(cleaned);
}

function firstUsefulLine(text: string): string {
  const cleaned = stripSkillMarkdown(text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const firstSentence = cleaned.split(/(?<=[。！？.!?])\s*/).find(part => part.trim().length >= 4) || cleaned;
  return firstSentence.trim();
}

function compactThreadTitle(title: string, fallback = 'Codex'): string {
  if (THREAD_ID_RE.test(title.trim())) return fallback;
  const markdownLink = title.match(/\[([^\]]+)\]\([^)]+\)/);
  const candidate = markdownLink?.[1]?.startsWith('$') ? title.replace(markdownLink[0], '') : (markdownLink?.[1] || title);
  const cleaned = stripSkillMarkdown(candidate)
    .replace(new RegExp('wechat-gggithub/wechat-' + 'cla' + 'ude-code', 'ig'), '\u5fae\u4fe1 Codex \u6865\u63a5')
    .replace(new RegExp('wechat-' + 'cla' + 'ude-code', 'ig'), 'WeChat-Codex')
    .replace(new RegExp('cla' + 'ude', 'ig'), 'Codex')
    .replace(/wechat-codex-code/ig, 'WeChat-Codex')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned && !looksLikeUnsafeText(cleaned) ? cleaned : fallback;
  return safe.length > 28 ? `${safe.slice(0, 27)}...` : safe;
}

function resolveThreadTitle(event: CompletionEvent): string {
  const candidates = [
    event.title,
    firstUsefulLine(event.firstUserMessage),
    firstUsefulLine(event.preview),
  ];
  for (const candidate of candidates) {
    if (THREAD_ID_RE.test(candidate.trim())) continue;
    if (!candidate || isLikelyGeneratedContentTitle(candidate)) continue;
    const compact = compactThreadTitle(candidate, '');
    if (compact && !looksLikeUnsafeText(compact)) return compact;
  }
  for (const candidate of candidates) {
    if (THREAD_ID_RE.test(candidate.trim())) continue;
    const compact = compactThreadTitle(firstUsefulLine(candidate), '');
    if (compact && !looksLikeUnsafeText(compact)) return compact;
  }
  return '';
}


function buildDesktopCompletionPushContent(event: CompletionEvent): CompletionPushContent | undefined {
  const title = resolveThreadTitle(event);
  const summary = safeCompletionSummary(event);
  if (!title || !summary) return undefined;
  if (looksLikeUnsafeText(title) || looksLikeUnsafeText(summary)) return undefined;
  return { title, summary };
}

function buildSafeDesktopCompletionPushMessage(content: CompletionPushContent): string {
  const { title, summary } = content;
  return `${title}\u5bf9\u8bdd\u5df2\u5b8c\u6210\n${summary}`;
}

function shouldSkipNoisyCompletionEvent(event: CompletionEvent): boolean {
  const title = resolveThreadTitle(event);
  if (!title) return true;
  if (looksLikeUnsafeText(title)) return true;
  return false;
}

function safeCompletionSummary(event: CompletionEvent): string {
  const readableLast = safeReadableText(event.lastAssistantMessage);
  if (readableLast) return readableLast;

  return '';
}

function safeReadableText(text: string): string {
  const cleaned = text
    .replace(/\[\$[\w-]+\]\([^)]+\)/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/(?:<oai-mem-citation>|<\/oai-mem-citation>|<citation_entries>|<\/citation_entries>|<rollout_ids>|<\/rollout_ids>)[\s\S]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(new RegExp('cla' + 'ude', 'ig'), 'Codex')
    .trim();
  if (!cleaned || looksLikeUnsafeText(cleaned)) return '';
  const withoutLead = cleaned
    .replace(/^(?:已完成|完成了|结果是|结论是|总结一下)[:：\s]*/i, '')
    .trim();
  const sentence = withoutLead.split(/(?<=[。！？.!?])\s*/).find(part => part.trim().length >= 6) || withoutLead;
  return sentence.length > 56 ? `${sentence.slice(0, 55)}...` : sentence;
}

function looksLikeUnsafeText(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return true;
  if (/[\uFFFD]|(?:\u93B4|\u9435|\u951B|\u7F01|\u6D60|\u701A|\u5B80|\u704F|\u9359|\u6FC2|\u9207)/.test(text)) {
    return true;
  }
  if (/\?{4,}/.test(compact)) return true;
  if (compact.length >= 8) {
    const questionMarks = (compact.match(/\?/g) || []).length;
    if (questionMarks / compact.length > 0.35) return true;
  }
  return false;
}

export function startCodexDesktopCompletionMonitor(options: MonitorOptions): () => void {
  if (process.platform !== 'win32') return () => {};
  if (!isPythonAvailable()) return () => {};

  let stopped = false;
  const persistedState = loadMonitorState();
  let lastLogId = persistedState.lastLogId || 0;
  let running = false;
  const notifiedThreadIds = new Set(persistedState.notifiedThreadIds || []);
  const lastNotifiedByThread = new Map<string, number>();

  function persistState(): void {
    saveMonitorState({
      lastLogId,
      notifiedThreadIds: Array.from(notifiedThreadIds).slice(-500),
    });
  }

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
        persistState();
      }

      for (const event of events) {
        const lastNotifiedAt = lastNotifiedByThread.get(event.threadId) ?? 0;
        if (
          notifiedThreadIds.has(event.threadId)
          || options.isBridgeThread(event.threadId)
          || options.shouldIgnoreThread?.(event)
          || shouldSkipNoisyCompletionEvent(event)
        ) {
          notifiedThreadIds.add(event.threadId);
          lastNotifiedByThread.set(event.threadId, Date.now());
          persistState();
          continue;
        }
        if (!(await isWindowsLocked())) {
          notifiedThreadIds.add(event.threadId);
          lastNotifiedByThread.set(event.threadId, Date.now());
          persistState();
          continue;
        }
        if (Date.now() - lastNotifiedAt < SAME_THREAD_NOTIFY_COOLDOWN_MS) continue;
        const content = buildDesktopCompletionPushContent(event);
        if (!content) {
          notifiedThreadIds.add(event.threadId);
          lastNotifiedByThread.set(event.threadId, Date.now());
          persistState();
          continue;
        }
        const summary = buildSafeDesktopCompletionPushMessage(content);
        const completionContext = {
          userText: `Codex Desktop thread: ${event.title}`,
          prompt: `Codex Desktop thread ${event.threadId}`,
          resultSummary: summary,
          fromUserId: options.account.userId || '',
          contextToken: options.getContextToken(),
          completedAt: Date.now(),
          provider: 'codex',
          sessionId: event.threadId,
        };
        options.session.lastCompletionContext = completionContext;
        options.session.lastDesktopCompletionContext = completionContext;
        options.sessionStore.save(options.account.accountId, options.session);

        if (options.account.userId) {
          await options.sender.sendText(options.account.userId, options.getContextToken(), summary);
          notifiedThreadIds.add(event.threadId);
          lastNotifiedByThread.set(event.threadId, Date.now());
          persistState();
        }
      }
    } catch (err) {
      logger.warn('Codex desktop completion monitor failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  }

  getLatestLogId().then(id => {
    if (!lastLogId) {
      lastLogId = id;
      persistState();
    }
  }).catch(() => {});
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
