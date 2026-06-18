import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import type { QueryOptions } from './codex/types.js';
import { handleForegroundCodexCommand } from './codex/foreground-command.js';
import { codexQuery } from './codex/provider.js';
import { startCodexDesktopCompletionMonitor } from './codex/desktop-completion-monitor.js';
import { isWindowsLocked } from './system/windows-lock.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

// Extensions eligible for auto-push when detected in Codex output.
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from Codex output text. */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  // Match absolute paths (macOS/Linux), tilde paths, and Windows paths with a file extension
  const regex = /(?:\/(?:Users|home|tmp|var|etc)\/[^\s`'"()\[\]{}|<>]+\.\w+|~\/[^\s`'"()\[\]{}|<>]+\.\w+|[A-Za-z]:[\\\/][^\s`'"()\[\]{}|<>]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const resolved = raw.startsWith('~')
      ? raw.replace(/^~/, homedir())
      : raw;
    paths.push(resolved);
  }
  return paths;
}

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Card-aware message splitter.
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'CodexCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();
  const bridgeThreadIds = new Set<string>();
  const stopCodexDesktopMonitor = startCodexDesktopCompletionMonitor({
    account,
    session,
    sessionStore,
    sender,
    getContextToken: () => sharedCtx.lastContextToken,
    isBridgeThread: (threadId) => bridgeThreadIds.has(threadId),
  });

  // -- Message queue for serial processing --
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      await handleMessage(msg, account!, session, sessionStore, sender, config, sharedCtx, activeControllers, messageQueue, bridgeThreadIds);
    }
    processingQueue = false;
  }

  // -- Wire the monitor callbacks --

  /** Handle priority commands (/stop, /clear) immediately, bypassing the serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;
    if (session.state !== 'processing') return false;

    const ctrl = activeControllers.get(account!.accountId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(account!.accountId); }
    session.state = 'idle';
    sessionStore.save(account!.accountId, session);

    if (text.startsWith('/stop')) {
      messageQueue.length = 0;
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      messageQueue.push(msg);
      drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    stopCodexDesktopMonitor();
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  messageQueue: WeixinMessage[],
  bridgeThreadIds: Set<string>,
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  const foregroundCommand = await handleForegroundCodexCommand(userText);
  if (foregroundCommand.handled && !imageItem && !fileItem) {
    if (foregroundCommand.reply) {
      await sender.sendText(fromUserId, contextToken, foregroundCommand.reply);
    }
    return;
  }

  const preference = extractUserPreference(userText);
  if (preference && !imageItem && !fileItem) {
    sessionStore.addUserPreference(session, preference);
    sessionStore.save(account.accountId, session);
    await sender.sendText(fromUserId, contextToken, '记住了，后面我会按这个方式调整。');
    return;
  }

  const instantReply = getInstantReply(userText, session);
  if (instantReply && !imageItem && !fileItem) {
    sessionStore.addChatMessage(session, 'user', userText);
    sessionStore.addChatMessage(session, 'assistant', instantReply);
    sessionStore.save(account.accountId, session);
    await sender.sendText(fromUserId, contextToken, instantReply);
    return;
  }

  // Drop non-command messages while processing (priority commands already handled upstream)
  if (session.state === 'processing' && !userText.startsWith('/')) {
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.codexPrompt) {
      await sendToCodex(
        result.codexPrompt, imageItem, fileItem, fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers, bridgeThreadIds,
      );
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled) return;

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Codex --

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  const promptText = buildFollowUpPrompt(userText, session);
  await sendToCodex(
    promptText, imageItem, fileItem, fromUserId, contextToken,
    account, session, sessionStore, sender, config, activeControllers, bridgeThreadIds,
    userText,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

function extractUserPreference(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return undefined;
  if (trimmed.length > 500) return undefined;

  const hasPreferenceCue = /(?:以后|后续|接下来|下次|之后|你以后|你后面|你要|你应该|你别|不要再|别再|不用|不需要|不必|记住|注意|改成|调整成)/.test(trimmed);
  const hasStyleCue = /(?:回复|回答|说话|语气|口吻|思考|理解|识别|判断|进度|反馈|上下文|记忆|联系|连续|分段|慢点|快点|简短|少一点|别啰嗦|不要废话|像.*聊天|微信|备注|自我介绍|少打扰)/.test(trimmed);
  const hasCorrectionCue = /(?:没有|没|不对|不是|不太对|漏了|忘了|缺少|不行|不够|没做到|没识别)/.test(trimmed);

  if (hasPreferenceCue && hasStyleCue) return trimmed;
  if (hasCorrectionCue && hasStyleCue) return trimmed;

  const directRule = trimmed.match(/^(?:记住|注意|规则)[:：\s]+([\s\S]{2,})$/);
  return directRule?.[1]?.trim();
}

function getInstantReply(text: string, session: Session): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return undefined;
  if (trimmed.length > 80) return undefined;

  if (/^(hi|hello|hey|你好|在吗|在不在|哈喽|哈罗|嗨)$/i.test(trimmed)) {
    return '在，你说。';
  }
  if (/^(ok|好|好的|收到|嗯|行|可以|明白|了解)$/i.test(trimmed)) {
    return '好。';
  }
  if (/^(谢谢|谢了|辛苦了|thx|thanks)$/i.test(trimmed)) {
    return '不客气。';
  }
  if (/(自我介绍|介绍一下你自己|你是谁)/.test(trimmed)) {
    return '我是 Codex，可以帮你处理这台电脑上的项目、代码、文档和文件。';
  }
  if (/(当前.*后端|现在.*后端|provider|通道).*(是什么|哪个|状态)?/i.test(trimmed)) {
    return '当前微信桥接后端是 CODEX。';
  }
  if (/(记住了吗|记得吗|偏好|规则).*(吗|有哪些|是什么)?/.test(trimmed)) {
    const prefs = (Array.isArray(session.userPreferences) ? session.userPreferences : []).filter(Boolean);
    if (prefs.length === 0) return '现在还没有保存偏好。';
    return `记得，当前主要有：\n${prefs.slice(-6).map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
  }

  return undefined;
}

function buildPreferenceSystemPrompt(session: Session): string | undefined {
  const preferences = (Array.isArray(session.userPreferences) ? session.userPreferences : [])
    .map(item => item.trim())
    .filter(Boolean);
  if (preferences.length === 0) return undefined;
  return [
    '用户在微信里明确要求你后续遵守这些沟通偏好。它们是后台规则，不要主动复述给用户：',
    ...preferences.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

export function summarizeCompletionForWechat(text: string, maxLen = 180): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '已完成。';
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
}

export function isLikelyCompletionFollowUp(text: string, session: Session): boolean {
  const trimmed = text.trim();
  const last = session.lastCompletionContext;
  if (!trimmed || trimmed.startsWith('/') || !last) return false;
  if (Date.now() - last.completedAt > 12 * 60 * 60 * 1000) return false;
  if (trimmed.length > 800) return false;
  if (isLikelyNewTopicRequest(trimmed)) return false;

  return /^(?:那|然后|继续|接着|再|帮我|把|改成|调整|优化|补充|按|就|可以|不对|不是|重新|还是|另外)/.test(trimmed)
    || /(?:基于|按照|上一条|刚才|这个|上面|前面|继续|改成|调整|优化|补充|重做|重新|修复|继续做|下一步)/.test(trimmed);
}

function isLikelyNewTopicRequest(text: string): boolean {
  if (/(?:另一个|另外一个|其他|别的|换个|换一个|新问题|另外问|不是这个|不是上个|不是上一条|不是刚才)/.test(text)) {
    return true;
  }
  if (/(?:我问的是|我说的是|你理解错了|你找错了)/.test(text)) {
    return true;
  }
  if (/(?:哪个|哪一个|某个|最近|有哪些).*(?:项目|对话|任务|进度|状态)/.test(text)) {
    return true;
  }
  if (/(?:项目|对话|任务).*(?:进度|状态|怎么样|到哪了|完成了吗)/.test(text) && !/(?:上一条|刚才|这个|上面|前面)/.test(text)) {
    return true;
  }
  return false;
}

function buildFollowUpPrompt(text: string, session: Session): string {
  if (!isLikelyCompletionFollowUp(text, session)) return text;
  const last = session.lastCompletionContext!;
  return [
    '用户正在基于上一条微信完成通知继续要求调整，请把它当成同一个任务的后续要求处理。',
    '',
    '上一任务：',
    last.userText || last.prompt,
    '',
    '上一结果摘要：',
    last.resultSummary,
    '',
    '用户现在的回复：',
    text,
  ].join('\n');
}

function isCodexOfflineError(error: string): boolean {
  return /(?:Failed to spawn codex|codex exited with code|ENOENT|EACCES|Access is denied|The system cannot find the file specified)/i.test(error);
}

async function sendToCodex(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
  bridgeThreadIds: Set<string>,
  originalUserText = userText,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', originalUserText || '(图片)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    // Download file if present
    let prompt = userText || '请分析这张图片';
    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    let textBuffer = '';
    let anySent = false;
    let lastSentTime = Date.now();

    const MIN_BATCH_FLUSH_LEN = 30;
    const SOFT_FLUSH_LIMIT = 3800;

    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }

    // Serial promise chain — each flushText() appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function flushText(): Promise<void> {
      // Capture and clear synchronously to prevent race condition:
      // new deltas can arrive while the chain awaits sendText,
      // causing the async callback to clear content it never captured.
      const captured = textBuffer.trim();
      textBuffer = '';
      if (!captured) return flushChain;

      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(captured);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
        anySent = true;
        lastSentTime = Date.now();
      }).catch((err) => {
        logger.error('flushText send failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return flushChain;
    }

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    const SILENCE_MESSAGES = [
      '我还在处理中，这个问题有点复杂，请再稍等一下',
      '正在努力干活中，马上就有结果了，请稍等片刻',
      '有点复杂正在处理，再给我一点时间，很快就好',
      '快好了别着急，正在收尾阶段，马上给你回复',
      '还在跑呢，任务量比较大，不过马上就能出结果了',
      '任务比想象的复杂一些，再等等我，正在全力处理',
      '正在处理中，进展顺利，再等一会儿就好',
      '还没完不过已经快了，再给我一分钟就能搞定',
      '我在认真思考这个问题，请再稍等一会儿',
      '稍微有点棘手，不过已经快解决了，再等我一下',
    ];
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        buildPreferenceSystemPrompt(session),
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: async (delta: string) => {
        textBuffer += delta;

        // Flush at structural boundaries (only if buffer is substantial) or when approaching size limit
        const shouldFlush =
          (endsWithStructuralBoundary(textBuffer) && textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN)
          || textBuffer.length > SOFT_FLUSH_LIMIT;

        if (shouldFlush) {
          await flushText();
        }
      },
      onBlockEnd: () => {
        if (textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN || textBuffer.length > SOFT_FLUSH_LIMIT) {
          flushText();
        }
      },
    };

    const result = await codexQuery(queryOptions);

    // Stop periodic flush and send any remaining buffered content
    clearInterval(flushTimer);
    await flushText();

    let completionSummary = '';

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Codex query had error but returned text, using text', { error: result.error });
      }
      completionSummary = summarizeCompletionForWechat(result.text);
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('AI query error', { provider: 'codex', error: result.error });
      const reply = isCodexOfflineError(result.error)
        ? 'Codex 已离线'
        : 'Codex 处理请求时出错，请稍后重试。';
      await sender.sendText(fromUserId, contextToken, reply);
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'Codex 已离线');
    }

    if (result.sessionId) {
      bridgeThreadIds.add(result.sessionId);
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    if (completionSummary) {
      session.lastCompletionContext = {
        userText: originalUserText,
        prompt,
        resultSummary: completionSummary,
        resultText: result.text,
        fromUserId,
        contextToken,
        completedAt: Date.now(),
        provider: 'codex',
        sessionId: result.sessionId || undefined,
      };
    }
    sessionStore.save(account.accountId, session);

    if (completionSummary && await isWindowsLocked()) {
      await sender.sendText(fromUserId, contextToken, `Codex 任务完成：${completionSummary}`);
    }

    // Auto-push deliverable files mentioned in Codex output.
    if (result.text) {
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const detectedPaths = extractFilePathsFromText(result.text, cwd);
      const { existsSync } = await import('node:fs');
      const { extname } = await import('node:path');
      const pushable = detectedPaths.filter(f => {
        const ext = extname(f).toLowerCase();
        return AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(f);
      });
      if (pushable.length > 0) {
        const failedFiles: string[] = [];
        for (const filePath of pushable) {
          try {
            await sender.sendFile(fromUserId, contextToken, filePath);
          } catch {
            failedFiles.push(filePath);
          }
        }
        if (failedFiles.length > 0) {
          // Server-side rate limit requires longer cooldown (observed ret:-2 even after 9s backoff)
          for (let attempt = 0; attempt < 3; attempt++) {
            const delay = (attempt + 1) * 15_000;
            logger.warn(`Rate-limited, retrying ${failedFiles.length} file(s) in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, delay));
            const stillFailed: string[] = [];
            for (const filePath of failedFiles) {
              try {
                await sender.sendFile(fromUserId, contextToken, filePath);
              } catch {
                stillFailed.push(filePath);
              }
            }
            if (stillFailed.length === 0) break;
            failedFiles.length = 0;
            failedFiles.push(...stillFailed);
          }
          if (failedFiles.length > 0) {
            logger.error('File delivery failed after all retries', { files: failedFiles });
            await sender.sendText(fromUserId, contextToken, `文件推送失败（服务端限频），请稍后重试。`).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Codex query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToCodex', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    clearInterval(flushTimer);
    stopTyping();
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];

  if (command === 'setup') {
    runSetup().catch((err) => {
      logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
      console.error('设置失败:', err);
      process.exit(1);
    });
  } else {
    // 'start' or no argument
    runDaemon().catch((err) => {
      logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
      console.error('启动失败:', err);
      process.exit(1);
    });
  }
}
