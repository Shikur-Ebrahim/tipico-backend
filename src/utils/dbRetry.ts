/**
 * Retry wrapper for transient pg-pool connection errors.
 *
 * Render's free PostgreSQL tier can momentarily refuse connections when
 * the pool is under load. Retrying with exponential back-off lets the
 * pool drain before the next attempt instead of immediately propagating
 * the timeout to callers.
 */

const RETRYABLE_FRAGMENTS = [
  'timeout exceeded when trying to connect',
  'ECONNREFUSED',
  'Connection terminated unexpectedly',
  'connection timeout',
  'getaddrinfo ENOTFOUND',
  'SSL SYSCALL error',
  'read ECONNRESET',
];

export function isTransientDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_FRAGMENTS.some((fragment) => msg.includes(fragment));
}

/**
 * Run `fn` and retry up to `maxAttempts - 1` times on transient DB errors.
 * Uses full-jitter exponential back-off so concurrent retriers spread out.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 3,
    baseDelayMs = 600,
  }: { maxAttempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === maxAttempts) {
        throw err;
      }
      // full-jitter: random in [0, baseDelay * 2^(attempt-1)]
      const cap = baseDelayMs * Math.pow(2, attempt - 1);
      const delay = Math.random() * cap;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
