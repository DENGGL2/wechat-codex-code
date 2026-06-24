import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export function loadWechatCodexRules(): string {
  try {
    return readFileSync(join(REPO_ROOT, 'WECHAT_CODEX_RULES.md'), 'utf-8');
  } catch {
    return '';
  }
}

export function isForbiddenWechatOutput(text: string): boolean {
  const forbiddenPhrases = [
    '上一条文字消息已经通过微信发送成功',
    '神笔',
    '我还在处理中',
    '快好了别着急',
    '正在努力干活',
    '任务比想象的复杂',
    '我在认真思考',
    'Playwright 默认浏览器没装',
    '当前目录看起来不像项目根目录',
    '我理解错了',
    '我现在直接看',
    '怎么启动',
  ];
  if (forbiddenPhrases.some(phrase => text.includes(phrase))) return true;

  return [
    /上一条文字消息已经通过微信发送成功/,
    /微信发送接口最近.*发送成功/,
    /我先.*找.*入口/,
  ].some(pattern => pattern.test(text));
}

export function stripInternalProcessText(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return cleaned;

  const lines = cleaned.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const sendMarkerLines = lines.filter(line => /^\s*(?:微信发送|发送文件|send-file|WECHAT_SEND_FILE)\s*[:：]/i.test(line));
  if (sendMarkerLines.length > 0) {
    const usefulLines = lines.filter(line => {
      if (sendMarkerLines.includes(line)) return false;
      return !isForbiddenWechatOutput(line) && !/^(?:我先|我现在|我再|刚才|电脑上有|服务启动|页面服务|截图已经生成|当前目录|这个项目已有)/.test(line);
    });
    return usefulLines.slice(-2).join('\n').trim();
  }

  const paragraphs = cleaned.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const useful = paragraphs.filter(part => !isForbiddenWechatOutput(part));
  if (useful.length > 0) return useful.slice(-2).join('\n\n').trim();

  const usefulLines = lines.filter(line => {
    return !isForbiddenWechatOutput(line) && !/^(?:我先|我现在|我再|刚才|电脑上有|服务启动|页面服务|截图已经生成|当前目录|这个项目已有)/.test(line);
  });
  return usefulLines.slice(-2).join('\n').trim();
}

export function buildWechatRuntimeRules(): string {
  const rules = loadWechatCodexRules();
  const compactRules = rules
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return /^(#|[-]|不要|用户|微信|完成|引用|截图|文件|长任务|\/clear|\/stop|成功回复)/.test(trimmed);
    })
    .join('\n')
    .slice(0, 5000);

  return [
    '微信运行硬规则：',
    '- 只输出可以直接发给用户看的最终结果，不输出内部过程、排查流水账或安慰式等待话术。',
    '- 用户问 Codex 电脑端最近对话、完成进度、项目进展时，优先查本机 Codex 对话/线程/目录/时间/结论，不要回答微信发送状态。',
    '- 用户给出项目目录或 URL 后，后续截图/运行效果必须优先使用该目录和 URL，不要猜测前台窗口或其他应用。',
    '- 长任务主要保持微信输入中，不要定时发送“我还在处理中”“快好了”等无信息文本。',
    '- 生成截图、图片或文件后，直接用“微信发送：绝对路径”触发桥接发送，普通回复保持很短。',
    compactRules,
  ].filter(Boolean).join('\n');
}
