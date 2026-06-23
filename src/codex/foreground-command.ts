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

  const slashCommand = trimmed.match(/^\/(?:input|paste|codex-input)\s+([\s\S]+)$/i);
  if (slashCommand?.[1]?.trim()) {
    return slashCommand[1].trim();
  }

  const explicitCommand = trimmed.match(/^(?:\u5e2e\u6211\u8f93\u5165|\u5e2e\u6211\u586b\u5165|\u8f93\u5165\u5230\s*codex|\u586b\u5165\s*codex|codex\s*\u8f93\u5165)[:\uff1a,\uff0c\s]+([\s\S]+)$/i);
  if (explicitCommand?.[1]?.trim()) {
    return explicitCommand[1].trim();
  }

  return undefined;
}

function isForegroundInputMetaQuestion(text: string): boolean {
  return /^(?:\u5e2e\u6211\u8f93\u5165|\u5e2e\u6211\u586b\u5165).*(?:\u529f\u80fd|\u600e\u4e48\u7528|\u662f\u4ec0\u4e48|\u5bf9\u5417|\u6709\u6ca1\u6709\u95ee\u9898|\u80fd\u4e0d\u80fd)/.test(text);
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
      reply: '\u5df2\u586b\u5165',
    };
  }

  return {
    handled: true,
    ok: false,
    reply: `\u6ca1\u6709\u586b\u5165\uff1a${result.error || '\u524d\u53f0\u7a97\u53e3\u4e0d\u662f Codex'}\u3002\u8bf7\u5148\u70b9\u4e00\u4e0b Codex \u8f93\u5165\u6846\uff0c\u518d\u91cd\u8bd5\u3002`,
  };
}
