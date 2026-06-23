import type { CommandContext, CommandResult } from './router.js';
const HELP_TEXT = `可用命令：

普通消息会直接交给 Codex 理解。
需要文件时，直接说“把桌面那个 XXX 文件发我”。

隐藏控制：
/clear  清除当前会话`;

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '已清除。', handled: true };
}

export function handleUnknown(cmd: string, _args: string): CommandResult {
  return {
    handled: true,
    reply: `/${cmd} 不是本地命令，会话、偏好、进度类问题请直接用自然语言说。`,
  };
}
