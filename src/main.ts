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
import type { QueryOptions } from './codex/types.js';
import { handleForegroundCodexCommand } from './codex/foreground-command.js';
import { codexQuery } from './codex/provider.js';
import { startCodexDesktopCompletionMonitor } from './codex/desktop-completion-monitor.js';
import { isWindowsLocked } from './system/windows-lock.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type MessageItem, type WeixinMessage } from './wechat/types.js';

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

const AUTO_PUSH_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
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

function isWechatSendMarkerLine(line: string): boolean {
  return /^\s*(?:微信发送|发送文件|send-file|WECHAT_SEND_FILE)\s*[:：]/i.test(line);
}

function stripWechatSendMarkerLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(line => !isExplicitFileSendMarkerLine(line))
    .join('\n')
    .trim();
}

function extractMarkedFilePathsFromText(text: string, cwd: string): string[] {
  const markedText = text
    .split(/\r?\n/)
    .filter(line => isExplicitFileSendMarkerLine(line))
    .join('\n');
  return extractFilePathsFromText(markedText, cwd);
}

function isExplicitFileSendMarkerLine(line: string): boolean {
  return /^\s*(?:\u5fae\u4fe1\u53d1\u9001|\u53d1\u9001\u6587\u4ef6|send-file|WECHAT_SEND_FILE)\s*[:\uff1a]/i.test(line);
}

function userAskedForImagePreview(text: string): boolean {
  return /(?:\u622a\u56fe|\u56fe\u7247|\u9884\u89c8).*(?:\u7ed9\u6211|\u53d1\u6211|\u770b\u770b|\u770b\u4e0b|\u770b\u4e00\u4e0b)|(?:\u7ed9\u6211|\u53d1\u6211).*(?:\u622a\u56fe|\u56fe\u7247|\u9884\u89c8)/.test(text);
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
    shouldIgnoreThread: (event) => {
      const cwd = event.cwd.replace(/^\\\\\?\\/, '').toLowerCase();
      return event.threadId === '019ecffb-ec4d-7f10-8490-210caa1dd89b'
        || cwd.includes('wechat-gggithub-wechat-' + 'cla' + 'ude-code-https');
    },
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

  /** Hidden local controls only. Natural-language requests go to Codex. */
  async function handleHardCommand(msg: WeixinMessage): Promise<boolean> {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list);
    const trimmed = text.trim();
    if (!trimmed.startsWith('/stop') && !trimmed.startsWith('/clear')) {
      return false;
    }

    const toUserId = msg.from_user_id!;
    const contextToken = msg.context_token ?? '';

    if (trimmed.startsWith('/stop')) {
      if (session.state !== 'processing') {
        await sender.sendText(toUserId, contextToken, '没有正在处理的任务。').catch(() => {});
        return true;
      }

      const ctrl = activeControllers.get(account!.accountId);
      if (ctrl) {
        ctrl.abort();
        activeControllers.delete(account!.accountId);
      }
      messageQueue.length = 0;
      session.state = 'idle';
      sessionStore.save(account!.accountId, session);
      await sender.sendText(toUserId, contextToken, '已停止。').catch(() => {});
      return true;
    }

    if (trimmed.startsWith('/clear')) {
      const ctrl = activeControllers.get(account!.accountId);
      if (ctrl) {
        ctrl.abort();
        activeControllers.delete(account!.accountId);
      }
      messageQueue.length = 0;
      const newSession = sessionStore.clear(account!.accountId, session);
      Object.assign(session, newSession);
      await sender.sendText(toUserId, contextToken, '已清除。').catch(() => {});
      return true;
    }

    return false;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (await handleHardCommand(msg)) return;
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
  const currentUserText = extractCurrentTextFromItems(msg.item_list);
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  const foregroundCommand = await handleForegroundCodexCommand(currentUserText);
  if (foregroundCommand.handled && !imageItem && !fileItem) {
    if (foregroundCommand.reply) {
      await sender.sendText(fromUserId, contextToken, foregroundCommand.reply);
    }
    return;
  }

  // -- Normal message -> Codex --

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToCodex(
    userText, imageItem, fileItem, fromUserId, contextToken,
    account, session, sessionStore, sender, config, activeControllers, bridgeThreadIds,
    currentUserText,
  );
}

function extractCurrentTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => {
    const text = extractText(item);
    const quotedText = extractQuotedText(item);

    if (quotedText && text) {
      return `用户引用了以下消息：\n${quotedText}\n\n用户当前问题：\n${text}`;
    }

    if (quotedText) {
      return `用户引用了以下消息：\n${quotedText}`;
    }

    return text;
  }).filter(Boolean).join('\n');
}

function extractQuotedText(item: MessageItem): string {
  const refItem = item.ref_msg?.message_item;
  if (!refItem) return '';

  const text = extractText(refItem).trim();
  if (text) return text;

  if (refItem.image_item) return '[引用了一张图片]';
  if (refItem.file_item) {
    const fileName = refItem.file_item.file_name;
    return fileName ? `[引用了文件：${fileName}]` : '[引用了一个文件]';
  }
  if (refItem.video_item) return '[引用了一个视频]';

  return '[引用了一条暂不支持解析的消息]';
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

function buildBridgeRuntimeContext(sender: ReturnType<typeof createSender>, session: Session): string | undefined {
  const deliveryStatus = sender.getDeliveryStatusSummary?.();
  const lines: string[] = [
    '微信桥接运行状态，仅作为你理解用户问题的背景，不要主动复述，除非用户问到微信回复、发送失败、限流、图片/文件没收到、推送是否成功等相关问题：',
  ];
  if (deliveryStatus) {
    lines.push(deliveryStatus);
  }
  if (session.lastDesktopCompletionContext?.sessionId) {
    lines.push(
      '最近一次桌面 Codex 完成通知，仅在用户问“最新对话/刚才那个/进展怎么样/继续改”这类问题时作为上下文：',
      session.lastDesktopCompletionContext.resultSummary,
    );
  }
  return lines.length > 1 ? lines.join('\n') : undefined;
}

function isCodexOfflineError(error: string): boolean {
  return /(?:Failed to spawn codex|codex exited with code|ENOENT|EACCES|Access is denied|The system cannot find the file specified)/i.test(error);
}

function polishWechatFinalReply(text: string): string {
  const cleaned = stripWechatSendMarkerLines(text).trim();
  if (!cleaned) return cleaned;

  const markers = [
    '进度我查到了',
    '当前可确认',
    '当前最新状态',
    '当前状态',
    '结论',
    '所以现在',
    '可以确认',
    '查到了',
  ];

  const markerIndex = markers
    .map(marker => cleaned.indexOf(marker))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0];

  if (markerIndex !== undefined && markerIndex > 0) {
    return cleaned.slice(markerIndex).trim();
  }

  const paragraphs = cleaned.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  if (paragraphs.length <= 2) return cleaned;

  const noisyLead = /^(?:我先|先查|我会|当前工作区|刚才|正在|继续|正则|换成|已经定位|我找到了|我再|我这边)/;
  const useful = paragraphs.filter((part, index) => index === paragraphs.length - 1 || !noisyLead.test(part));
  const result = useful.join('\n\n').trim();
  return result || paragraphs[paragraphs.length - 1];
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
        '如果用户用自然语言要求你发送电脑里的文件，例如“把桌面那个 XXX 文件发我”，你需要自己根据语义查找候选文件。只有唯一确认要发送的文件时，单独输出一行“微信发送：绝对路径”；如果候选不唯一，先用简短中文向用户确认。不要要求用户提供精确路径。',
        '桥接层只负责转发微信消息、收发文件图片、填入前台 Codex 输入框和报告运行状态。用户的聊天、咨询、进度追问、引用追问、沟通偏好、后续修改要求，都由你按语义理解和处理。',
        buildBridgeRuntimeContext(sender, session),
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
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
      const finalReply = polishWechatFinalReply(result.text);
      completionSummary = summarizeCompletionForWechat(finalReply);
      sessionStore.addChatMessage(session, 'assistant', finalReply);
      // Send only the final polished answer to WeChat. Intermediate Codex progress is too noisy here.
      if (!anySent) {
        const chunks = splitMessage(finalReply);
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

    // Auto-push deliverable files mentioned in Codex output.
    if (result.text) {
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const markedPaths = extractMarkedFilePathsFromText(result.text, cwd);
      const detectedPaths = markedPaths.length > 0
        ? markedPaths
        : userAskedForImagePreview(originalUserText)
          ? extractFilePathsFromText(result.text, cwd)
          : [];
      const { existsSync } = await import('node:fs');
      const { extname } = await import('node:path');
      const pushable = detectedPaths.filter(f => {
        const ext = extname(f).toLowerCase();
        if (!AUTO_PUSH_EXTENSIONS.has(ext) || !existsSync(f)) return false;
        return markedPaths.length > 0 || AUTO_PUSH_IMAGE_EXTENSIONS.has(ext);
      });
      const filesToPush = markedPaths.length > 0 ? pushable : pushable.length === 1 ? pushable : [];
      if (filesToPush.length > 0) {
        const failedFiles: string[] = [];
        for (const filePath of filesToPush) {
          try {
            await sender.sendFile(fromUserId, contextToken, filePath);
          } catch {
            failedFiles.push(filePath);
          }
        }
        if (failedFiles.length > 0) {
          logger.error('File delivery failed; skipping immediate retries to avoid rate limit spam', { files: failedFiles });
          await sender.sendText(fromUserId, contextToken, `文件推送失败，微信发送接口可能正在限频，请稍后再让我发一次。`).catch(() => {});
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
