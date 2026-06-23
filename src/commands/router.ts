import type { Session } from '../session.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  codexPrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text
 *   /clear    - Clear the current session
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    default:
      return handleUnknown(cmd, args);
  }
}
