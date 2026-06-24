import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBridgeRuntimeContext,
  extractMarkedFilePathsFromText,
  polishWechatFinalReply,
  stripWechatSendMarkerLines,
  summarizeCompletionForWechat,
  userAskedForImagePreview,
} from '../main.js';
import type { Session } from '../session.js';
import { runAcceptanceScenarios } from '../wechat-acceptance-scenarios.js';
import { buildWechatRuntimeRules, isForbiddenWechatOutput } from '../wechat-policy.js';

const badProgressReply = '最近进度：上一条文字消息已经通过微信发送成功，时间大约是 1 分钟前；目前没有看到文件或图片发送失败的提示。';
const badScreenshotReply = '我看到当前有一个“神笔”窗口在运行，应该就是你要看的结果。我现在抓取桌面截图保存成图片。';
const noisyKeepAliveReplies = [
  '我还在处理中，这个问题有点复杂，请再稍等一下',
  '快好了别着急，正在收尾阶段，马上给你回复',
];
const badProcessReply = [
  '我理解错了，你要的是项目运行效果截图，不是随便截屏。我现在直接看当前项目怎么启动，跑起来后截页面效果图，最后把截图文件路径发给你。',
  '当前目录看起来不像项目根目录，我先在附近位置找可运行项目入口，比如 package.json。',
  '刚才 Playwright 默认浏览器没装，所以第一次截图文件没有真正生成。',
  '电脑上有 Edge，我用 --channel msedge 重新截图。',
  '截图已经生成了。',
  '微信发送：D:\\CodexWork\\wechat-screenshots\\openpencil-project-effect-20260623-203622.png',
].join('\n');

function hasForbiddenWechatContent(text: string): boolean {
  return isForbiddenWechatOutput(text);
}

test('A1 rejects WeChat delivery status as Codex desktop progress', () => {
  assert.equal(hasForbiddenWechatContent(badProgressReply), true);
});

test('A2 rejects foreground-window screenshot target when user provided project URL', () => {
  assert.equal(hasForbiddenWechatContent(badScreenshotReply), true);
});

test('A3 documents keepalive text as forbidden WeChat output', () => {
  for (const reply of noisyKeepAliveReplies) {
    assert.equal(hasForbiddenWechatContent(reply), true);
  }
});

test('A5 strips explicit file-send marker from text reply and extracts the file path', () => {
  const files = extractMarkedFilePathsFromText(badProcessReply, 'C:\\Users\\Administrator');
  assert.deepEqual(files, ['D:\\CodexWork\\wechat-screenshots\\openpencil-project-effect-20260623-203622.png']);
  assert.equal(stripWechatSendMarkerLines(badProcessReply).includes('微信发送：'), false);
});

test('A5 final WeChat reply does not leak internal process text', () => {
  const polished = polishWechatFinalReply(badProcessReply);
  assert.equal(hasForbiddenWechatContent(polished), false);
  assert.equal(polished.includes('微信发送：'), false);
});

test('image preview detection covers screenshot requests', () => {
  assert.equal(userAskedForImagePreview('跑的结果怎么样呢截个图给我'), true);
});

test('desktop completion context is separate from WeChat delivery status', () => {
  const session: Session = {
    workingDirectory: 'C:\\work',
    state: 'idle',
    chatHistory: [],
    lastDesktopCompletionContext: {
      userText: 'Codex Desktop thread: 查询项目实现逻辑',
      prompt: 'Codex Desktop thread abc',
      resultSummary: '查询项目实现逻辑对话已完成\n整理了本地网页和 3D 场景实现方式。',
      fromUserId: 'u',
      contextToken: 'c',
      completedAt: Date.now(),
      sessionId: 'abc',
    },
  };
  const ctx = buildBridgeRuntimeContext({
    getDeliveryStatusSummary: () => '最近一次文字消息约 1 分钟前发送成功。',
  }, session);
  assert.match(ctx || '', /最近一次桌面 Codex 完成通知/);
  assert.match(ctx || '', /查询项目实现逻辑对话已完成/);
});

test('completion summary remains short enough for a WeChat progress line', () => {
  const summary = summarizeCompletionForWechat(badProcessReply, 80);
  assert.ok(summary.length <= 80);
});

test('runtime rules are injected with desktop-progress and screenshot target constraints', () => {
  const rules = buildWechatRuntimeRules();
  assert.match(rules, /最近对话/);
  assert.match(rules, /目录或 URL/);
  assert.match(rules, /不要定时发送/);
});

test('positive acceptance scenarios return concrete user-facing results', () => {
  const results = runAcceptanceScenarios();
  assert.ok(results.length >= 3);
  for (const result of results) {
    assert.equal(result.passed, true, `${result.id}: ${result.notes.join('; ')}`);
    assert.notEqual(result.actual.trim(), '');
  }
});
