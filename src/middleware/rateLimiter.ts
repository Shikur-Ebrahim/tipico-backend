import { Request, Response, NextFunction } from 'express';

/**
 * Do not mount on `app.use()` for the whole API: it counts every inbound HTTP request
 * (login, betting, polling) toward 75k/day per IP — unrelated to API-Sports quota.
 * Football API daily limit (75,000) is enforced in `services/apiQuota.ts` on outbound calls only.
 */
const DAILY_LIMIT = 75000;
const counters = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of counters) {
    if (now > data.resetAt) {
      counters.delete(key);
    }
  }
}, 60000);

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  let entry = counters.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: todayEnd.getTime() };
    counters.set(key, entry);
  }

  entry.count++;

  res.setHeader('X-RateLimit-Limit', DAILY_LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, DAILY_LIMIT - entry.count));
  res.setHeader('X-RateLimit-Reset', entry.resetAt);

  if (entry.count > DAILY_LIMIT) {
    res.status(429).json({ error: 'Daily request limit exceeded (75,000)' });
    return;
  }

  next();
}
