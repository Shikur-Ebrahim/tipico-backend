import pool from '../config/database';

const DAILY_LIMIT = 75000;

export class ApiQuotaExceededError extends Error {
  constructor() {
    super('API-Football daily quota exceeded (75,000 requests)');
    this.name = 'ApiQuotaExceededError';
  }
}

function mapUsageRow(row: {
  usage_date: string;
  request_count: number;
  quota_limit: number;
  last_endpoint: string | null;
  last_request_at: Date | null;
}) {
  return {
    usageDate: row.usage_date,
    requestCount: row.request_count,
    quotaLimit: row.quota_limit,
    remaining: Math.max(0, row.quota_limit - row.request_count),
    lastEndpoint: row.last_endpoint,
    lastRequestAt: row.last_request_at,
  };
}

export async function getApiUsageStatus() {
  await pool.query(
    `INSERT INTO api_request_usage (usage_date, request_count, quota_limit, last_request_at)
     VALUES (CURRENT_DATE, 0, $1, NOW())
     ON CONFLICT (usage_date) DO NOTHING`,
    [DAILY_LIMIT]
  );

  await pool.query(
    `UPDATE api_request_usage
     SET quota_limit = $1
     WHERE usage_date = CURRENT_DATE
       AND (quota_limit IS NULL OR quota_limit < 1)`,
    [DAILY_LIMIT]
  );

  const { rows } = await pool.query(
    `SELECT usage_date, request_count, quota_limit, last_endpoint, last_request_at
     FROM api_request_usage
     WHERE usage_date = CURRENT_DATE`
  );

  if (!rows[0]) {
    return {
      usageDate: new Date().toISOString().slice(0, 10),
      requestCount: 0,
      quotaLimit: DAILY_LIMIT,
      remaining: DAILY_LIMIT,
      lastEndpoint: null,
      lastRequestAt: null,
    };
  }

  return mapUsageRow(rows[0]);
}

export async function consumeApiRequest(endpoint: string) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO api_request_usage (usage_date, request_count, quota_limit, last_endpoint, last_request_at)
       VALUES (CURRENT_DATE, 0, $1, $2, NOW())
       ON CONFLICT (usage_date) DO NOTHING`,
      [DAILY_LIMIT, endpoint]
    );

    /* Bad legacy rows: quota_limit NULL/0 made `request_count < quota_limit` never true → false "quota exceeded". */
    await client.query(
      `UPDATE api_request_usage
       SET quota_limit = $1
       WHERE usage_date = CURRENT_DATE
         AND (quota_limit IS NULL OR quota_limit < 1)`,
      [DAILY_LIMIT]
    );

    const updateResult = await client.query(
      `UPDATE api_request_usage
       SET request_count = request_count + 1,
           quota_limit = $2,
           last_endpoint = $1,
           last_request_at = NOW()
       WHERE usage_date = CURRENT_DATE
         AND request_count < $2
       RETURNING usage_date, request_count, quota_limit, last_endpoint, last_request_at`,
      [endpoint, DAILY_LIMIT]
    );

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ApiQuotaExceededError();
    }

    await client.query('COMMIT');
    return mapUsageRow(updateResult.rows[0]);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      return Promise.reject(error);
    }

    throw error;
  } finally {
    client.release();
  }
}

export function isApiQuotaExceededError(error: unknown): error is ApiQuotaExceededError {
  return error instanceof ApiQuotaExceededError;
}
