import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { loadJson, saveJson, validateAccountId } from '../store.js';
import { logger } from '../logger.js';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
}

const ACCOUNTS_DIR = join(homedir(), '.wechat-codex-code', 'accounts');
const LEGACY_ACCOUNTS_DIR = join(homedir(), '.wechat-' + 'cla' + 'ude-code', 'accounts');

function accountPath(accountId: string, baseDir = ACCOUNTS_DIR): string {
  validateAccountId(accountId);
  return join(baseDir, `${accountId}.json`);
}

/** Persist account credentials to disk. */
export function saveAccount(data: AccountData): void {
  const filePath = accountPath(data.accountId);
  saveJson(filePath, data);
  logger.info('Account saved', { accountId: data.accountId });
}

/** Load account credentials by ID. Returns null if not found. */
export function loadAccount(accountId: string): AccountData | null {
  let filePath = accountPath(accountId);
  const data = loadJson<AccountData | null>(filePath, null);
  if (data) {
    logger.info('Account loaded', { accountId });
    return data;
  }

  filePath = accountPath(accountId, LEGACY_ACCOUNTS_DIR);
  const legacyData = loadJson<AccountData | null>(filePath, null);
  if (legacyData) {
    logger.info('Legacy account loaded', { accountId });
  }
  return legacyData;
}

/** Load the most recently modified account. Returns null if none exist. */
export function loadLatestAccount(): AccountData | null {
  const account = loadLatestAccountFromDir(ACCOUNTS_DIR);
  if (account) return account;
  return loadLatestAccountFromDir(LEGACY_ACCOUNTS_DIR);
}

function loadLatestAccountFromDir(accountsDir: string): AccountData | null {
  try {
    const files = readdirSync(accountsDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return null;

    let latestFile = files[0];
    let latestMtime = 0;

    for (const file of files) {
      const stat = statSync(join(accountsDir, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    }

    const accountId = latestFile.replace(/\.json$/, '');
    const data = loadJson<AccountData | null>(accountPath(accountId, accountsDir), null);
    if (data) {
      logger.info(accountsDir === LEGACY_ACCOUNTS_DIR ? 'Legacy account loaded' : 'Account loaded', { accountId });
    }
    return data;
  } catch {
    // Directory does not exist or is unreadable
    return null;
  }
}
