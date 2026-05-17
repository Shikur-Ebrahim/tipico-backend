import pool from '../config/database';
import {
  ensureAppSettings,
  WITHDRAWAL_MIN_DEPOSIT_KEY,
  DEFAULT_MIN_TOTAL_DEPOSIT,
} from '../db/ensureAppSettings';

export async function getWithdrawalMinTotalDeposit(): Promise<number> {
  await ensureAppSettings();
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [
    WITHDRAWAL_MIN_DEPOSIT_KEY,
  ]);
  if (result.rows.length === 0) return DEFAULT_MIN_TOTAL_DEPOSIT;
  const raw = result.rows[0].value;
  const amount =
    raw && typeof raw === 'object' && 'amount' in raw
      ? Number((raw as { amount: unknown }).amount)
      : Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_MIN_TOTAL_DEPOSIT;
}

export async function setWithdrawalMinTotalDeposit(amount: number): Promise<number> {
  await ensureAppSettings();
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [WITHDRAWAL_MIN_DEPOSIT_KEY, JSON.stringify({ amount })]
  );
  return amount;
}

export async function getUserApprovedDepositTotal(userId: number): Promise<number> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM deposit_requests
     WHERE user_id = $1 AND status = 'approved'`,
    [userId]
  );
  const total = parseFloat(result.rows[0]?.total ?? '0');
  return Number.isFinite(total) ? total : 0;
}

export async function checkWithdrawalDepositEligibility(userId: number): Promise<{
  eligible: boolean;
  totalDeposits: number;
  minRequired: number;
}> {
  const [minRequired, totalDeposits] = await Promise.all([
    getWithdrawalMinTotalDeposit(),
    getUserApprovedDepositTotal(userId),
  ]);
  return {
    eligible: totalDeposits >= minRequired,
    totalDeposits,
    minRequired,
  };
}
