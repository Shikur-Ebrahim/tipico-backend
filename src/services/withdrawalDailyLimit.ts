import pool from '../config/database';
import { ensureWithdrawalSchema } from '../db/ensureWithdrawalRequests';

export const MAX_DAILY_WITHDRAWAL_ETB = 100_000;
const TZ = 'Africa/Addis_Ababa';

/** Sum of today's pending + approved withdrawals (rejected do not count). */
export async function getUserDailyWithdrawalTotal(userId: number): Promise<number> {
  await ensureWithdrawalSchema();
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM withdrawal_requests
     WHERE user_id = $1
       AND status IN ('pending', 'approved')
       AND (created_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date`,
    [userId, TZ]
  );
  const total = parseFloat(result.rows[0]?.total ?? '0');
  return Number.isFinite(total) ? total : 0;
}

export async function getDailyWithdrawalLimitInfo(userId: number): Promise<{
  maxDaily: number;
  withdrawnToday: number;
  remainingToday: number;
}> {
  const withdrawnToday = await getUserDailyWithdrawalTotal(userId);
  const remainingToday = Math.max(0, MAX_DAILY_WITHDRAWAL_ETB - withdrawnToday);
  return {
    maxDaily: MAX_DAILY_WITHDRAWAL_ETB,
    withdrawnToday,
    remainingToday,
  };
}

export function formatDailyLimitMessage(
  withdrawnToday: number,
  remainingToday: number,
  requestAmount?: number
): string {
  if (requestAmount != null && requestAmount > MAX_DAILY_WITHDRAWAL_ETB) {
    return `Maximum withdrawal per request is ${MAX_DAILY_WITHDRAWAL_ETB.toLocaleString()} ETB.`;
  }
  if (remainingToday <= 0) {
    return `Daily withdrawal limit reached (${MAX_DAILY_WITHDRAWAL_ETB.toLocaleString()} ETB per day). You have withdrawn ${withdrawnToday.toLocaleString()} ETB today.`;
  }
  if (requestAmount != null && requestAmount > remainingToday) {
    return `Daily limit is ${MAX_DAILY_WITHDRAWAL_ETB.toLocaleString()} ETB. You have withdrawn ${withdrawnToday.toLocaleString()} ETB today — you can withdraw up to ${remainingToday.toLocaleString()} ETB more today.`;
  }
  return `Daily withdrawal limit: ${MAX_DAILY_WITHDRAWAL_ETB.toLocaleString()} ETB per day.`;
}

export async function checkDailyWithdrawalLimit(
  userId: number,
  requestAmount: number
): Promise<{ allowed: boolean; message?: string; withdrawnToday: number; remainingToday: number }> {
  const { withdrawnToday, remainingToday } = await getDailyWithdrawalLimitInfo(userId);

  if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
    return {
      allowed: false,
      message: 'Valid amount is required',
      withdrawnToday,
      remainingToday,
    };
  }

  if (requestAmount > MAX_DAILY_WITHDRAWAL_ETB) {
    return {
      allowed: false,
      message: formatDailyLimitMessage(withdrawnToday, remainingToday, requestAmount),
      withdrawnToday,
      remainingToday,
    };
  }

  if (requestAmount > remainingToday) {
    return {
      allowed: false,
      message: formatDailyLimitMessage(withdrawnToday, remainingToday, requestAmount),
      withdrawnToday,
      remainingToday,
    };
  }

  return { allowed: true, withdrawnToday, remainingToday };
}
