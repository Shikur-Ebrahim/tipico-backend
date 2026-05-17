import pool from '../config/database';
import {
  ensureAppSettings,
  SUPPORT_TELEGRAM_KEY,
  DEFAULT_SUPPORT_TELEGRAM_USERNAME,
} from '../db/ensureAppSettings';

function normalizeTelegramUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_SUPPORT_TELEGRAM_USERNAME;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function telegramUsernameToUrl(username: string): string {
  const handle = username.trim().replace(/^@+/, '');
  return `https://t.me/${encodeURIComponent(handle)}`;
}

export async function getSupportTelegramUsername(): Promise<string> {
  await ensureAppSettings();
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [
    SUPPORT_TELEGRAM_KEY,
  ]);
  if (result.rows.length === 0) return DEFAULT_SUPPORT_TELEGRAM_USERNAME;
  const raw = result.rows[0].value;
  const username =
    raw && typeof raw === 'object' && 'username' in raw
      ? String((raw as { username: unknown }).username)
      : typeof raw === 'string'
        ? raw
        : '';
  return normalizeTelegramUsername(username || DEFAULT_SUPPORT_TELEGRAM_USERNAME);
}

export async function setSupportTelegramUsername(username: string): Promise<string> {
  await ensureAppSettings();
  const normalized = normalizeTelegramUsername(username);
  const handle = normalized.replace(/^@+/, '');
  if (!handle || !/^[a-zA-Z0-9_]{5,32}$/.test(handle)) {
    throw new Error('Invalid Telegram username');
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [SUPPORT_TELEGRAM_KEY, JSON.stringify({ username: normalized })]
  );
  return normalized;
}
