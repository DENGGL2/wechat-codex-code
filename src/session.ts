import { loadJson, saveJson, validateAccountId } from './store.js';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DEFAULT_WORKING_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type SessionState = 'idle' | 'processing';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface CompletionContext {
  userText: string;
  prompt: string;
  resultSummary: string;
  resultText?: string;
  fromUserId: string;
  contextToken: string;
  completedAt: number;
  provider?: string;
  sessionId?: string;
}

export interface Session {
  sdkSessionId?: string;
  previousSdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
  userPreferences?: string[];
  lastCompletionContext?: CompletionContext;
}

const DEFAULT_MAX_HISTORY = 100;

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    validateAccountId(accountId);
    const session = loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: DEFAULT_WORKING_DIR,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
      userPreferences: [],
    });

    // Backward compatibility: ensure chatHistory exists
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }
    if (!Array.isArray(session.userPreferences)) {
      session.userPreferences = typeof session.userPreferences === 'string'
        ? [session.userPreferences]
        : [];
    }
    if (!session.userPreferences) {
      session.userPreferences = [];
    }

    return session;
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length before saving
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      sdkSessionId: undefined,          // explicitly clear so Object.assign removes it
      previousSdkSessionId: undefined,
      workingDirectory: currentSession?.workingDirectory ?? DEFAULT_WORKING_DIR,
      model: currentSession?.model,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
      userPreferences: currentSession?.userPreferences || [],
      lastCompletionContext: undefined,
    };
    save(accountId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Claude';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  function addUserPreference(session: Session, preference: string): void {
    const normalized = preference.trim();
    if (!normalized) return;
    const current = Array.isArray(session.userPreferences)
      ? session.userPreferences
      : typeof session.userPreferences === 'string'
        ? [session.userPreferences]
        : [];
    session.userPreferences = [
      ...current.filter(item => item !== normalized),
      normalized,
    ].slice(-20);
  }

  return { load, save, clear, addChatMessage, getChatHistoryText, addUserPreference };
}
