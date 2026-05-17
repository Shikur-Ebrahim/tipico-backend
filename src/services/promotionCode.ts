import pool from '../config/database';
import { ensurePromotionCodesSchema } from '../db/ensurePromotionCodesSchema';

const CODE_PATTERN = /^T\d{2}[A-Z]{2}\d{2}[A-Z]{2}\d$/;

function randomDigit(): string {
  return String(Math.floor(Math.random() * 10));
}

function randomLetter(): string {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

export function buildPromotionCode(): string {
  return (
    'T' +
    randomDigit() +
    randomDigit() +
    randomLetter() +
    randomLetter() +
    randomDigit() +
    randomDigit() +
    randomLetter() +
    randomLetter() +
    randomDigit()
  );
}

/** Normalize to +251XXXXXXXXX when possible. */
export function normalizePhone(raw: string): string {
  let p = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!p) return '';
  if (p.startsWith('+')) {
    return p;
  }
  if (p.startsWith('251')) {
    return `+${p}`;
  }
  if (p.startsWith('0') && p.length >= 10) {
    return `+251${p.slice(1)}`;
  }
  if (/^\d{9}$/.test(p)) {
    return `+251${p}`;
  }
  return p.startsWith('+') ? p : `+${p}`;
}

export async function allocateUniquePromotionCode(maxAttempts = 40): Promise<string> {
  await ensurePromotionCodesSchema();
  for (let i = 0; i < maxAttempts; i++) {
    const code = buildPromotionCode();
    if (!CODE_PATTERN.test(code)) continue;
    const dup = await pool.query('SELECT 1 FROM user_promotion_codes WHERE code = $1', [code]);
    if (dup.rows.length === 0) return code;
  }
  throw new Error('Could not allocate a unique promotion code');
}

export async function getPromotionCodeByPhone(phone: string): Promise<string | null> {
  await ensurePromotionCodesSchema();
  const normalized = normalizePhone(phone);
  const result = await pool.query(
    'SELECT code FROM user_promotion_codes WHERE phone = $1',
    [normalized]
  );
  return result.rows[0]?.code ?? null;
}

async function resolveStoredPhone(phone: string): Promise<string> {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 10) {
    throw new Error('Valid phone number is required');
  }
  const userMatch = await pool.query(
    `SELECT phone FROM users
     WHERE phone = $1 OR phone = $2 OR phone = $3
     LIMIT 1`,
    [phone.trim(), normalized, normalized.replace(/^\+/, '')]
  );
  if (userMatch.rows.length > 0) {
    return userMatch.rows[0].phone as string;
  }
  return normalized;
}

export async function generatePromotionCodeForPhone(phone: string): Promise<{
  phone: string;
  code: string;
  created: boolean;
}> {
  await ensurePromotionCodesSchema();
  const storedPhone = await resolveStoredPhone(phone);

  const existing = await pool.query(
    'SELECT phone, code FROM user_promotion_codes WHERE phone = $1',
    [storedPhone]
  );
  if (existing.rows.length > 0) {
    return {
      phone: existing.rows[0].phone,
      code: existing.rows[0].code,
      created: false,
    };
  }

  const code = await allocateUniquePromotionCode();
  const inserted = await pool.query(
    `INSERT INTO user_promotion_codes (phone, code)
     VALUES ($1, $2)
     RETURNING phone, code`,
    [storedPhone, code]
  );
  return {
    phone: inserted.rows[0].phone,
    code: inserted.rows[0].code,
    created: true,
  };
}

export async function validatePromotionCodeForUser(
  userId: number,
  promoCode: string
): Promise<{ valid: boolean; message?: string }> {
  await ensurePromotionCodesSchema();
  const userRes = await pool.query('SELECT phone FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) {
    return { valid: false, message: 'User not found' };
  }
  const userPhone = userRes.rows[0].phone as string;
  const lookupPhone = await resolveStoredPhone(userPhone).catch(() => userPhone);
  const code = String(promoCode ?? '').trim().toUpperCase();
  if (!code || !CODE_PATTERN.test(code)) {
    return { valid: false, message: 'Please enter correct agent ID code' };
  }

  const row = await pool.query(
    'SELECT phone, code FROM user_promotion_codes WHERE phone = $1 OR phone = $2',
    [userPhone, lookupPhone]
  );
  if (row.rows.length === 0) {
    return {
      valid: false,
      message: 'No promotion code has been issued for your account. Contact support.',
    };
  }
  if (row.rows[0].code !== code) {
    return { valid: false, message: 'Please enter correct agent ID code' };
  }
  return { valid: true };
}
