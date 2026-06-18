import { pasteIntoForegroundCodex } from './foreground-input.js';

export interface ForegroundCommandResult {
  handled: boolean;
  ok?: boolean;
  reply?: string;
}

export function parseForegroundCodexInput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (isForegroundInputMetaQuestion(trimmed)) return undefined;

  const command = trimmed.match(/^\/(?:input|paste|codex-input)\s+([\s\S]+)$/i);
  if (command?.[1]?.trim()) {
    return command[1].trim();
  }

  const natural = trimmed.match(/^(?:转到|转给|输入到|填入|粘贴到|发到)\s*codex(?:输入框)?[：:\s]+([\s\S]+)$/i);
  if (natural?.[1]?.trim()) {
    return natural[1].trim();
  }

  const helpMeInput = trimmed.match(/^帮我输入(?:到\s*codex(?:输入框)?)?(?:[：:\s]+|(?=\S))([\s\S]+)$/i);
  if (helpMeInput?.[1]?.trim()) {
    return helpMeInput[1].trim();
  }

  return undefined;
}

function isForegroundInputMetaQuestion(text: string): boolean {
  return /^帮我输入(?:到\s*codex(?:输入框)?)?(?:这个)?功能/.test(text)
    || /^帮我输入(?:到\s*codex(?:输入框)?)?.*(?:没问题|对吧|还在吗|怎么用|是什么|是否|能不能)/.test(text);
}

export async function handleForegroundCodexCommand(text: string): Promise<ForegroundCommandResult> {
  const input = parseForegroundCodexInput(text);
  if (!input) {
    return { handled: false };
  }

  const result = await pasteIntoForegroundCodex(input);
  if (result.ok) {
    return {
      handled: true,
      ok: true,
      reply: '已填入',
    };
  }

  return {
    handled: true,
    ok: false,
    reply: `没有填入：${result.error || '前台窗口不是 Codex'}。请先点一下 Codex 输入框，再重试。`,
  };
}

