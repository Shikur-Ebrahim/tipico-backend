/**
 * Groq OpenAI-compatible chat completions for the support assistant.
 */

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

export const SUPPORT_SYSTEM_PROMPT = `You are a professional football betting website support assistant.

Help users with: deposits, withdrawals, betting help, odds explanation, live betting, bonuses, account help, and responsible betting.

Guidelines:
- Keep every reply short (1–4 sentences unless step-by-step help is required).
- Be professional, friendly, and clear.
- Do not invent account balances, transaction IDs, or bonus amounts — direct users to check their account or contact human support for account-specific issues.
- Encourage responsible betting when relevant.
- If unsure, suggest contacting support via the site or Telegram.`;

export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

function resolveModels(): string[] {
  const preferred = process.env.GROQ_MODEL?.trim();
  const chain = [preferred, 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'].filter(
    (m): m is string => Boolean(m)
  );
  return [...new Set(chain)];
}

function isRetryableModelError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('decommissioned') ||
    lower.includes('no longer supported') ||
    lower.includes('model_not_found') ||
    lower.includes('does not exist') ||
    lower.includes('invalid model')
  );
}

async function callGroqModel(
  apiKey: string,
  model: string,
  history: ChatTurn[]
): Promise<string> {
  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SUPPORT_SYSTEM_PROMPT },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: 0.6,
      max_tokens: 400,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (!response.ok) {
    const detail = payload.error?.message || response.statusText;
    throw new Error(`Groq API error: ${detail}`);
  }

  const reply = payload.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error('Empty response from Groq');
  }

  return reply;
}

export async function getGroqChatReply(history: ChatTurn[]): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured on the server');
  }

  const models = resolveModels();
  let lastError: Error | null = null;

  for (const model of models) {
    try {
      return await callGroqModel(apiKey, model, history);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(message);
      if (!isRetryableModelError(message)) {
        throw lastError;
      }
      console.warn(`[chat] model ${model} unavailable, trying next…`);
    }
  }

  throw lastError ?? new Error('Groq request failed');
}
