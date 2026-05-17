import { Request, Response } from 'express';
import { ChatTurn, getGroqChatReply } from '../services/groqService';

const MAX_MESSAGES = 24;
const MAX_CONTENT_LENGTH = 2000;

function isValidTurn(value: unknown): value is ChatTurn {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const role = row.role;
  const content = row.content;
  return (
    (role === 'user' || role === 'assistant') &&
    typeof content === 'string' &&
    content.trim().length > 0 &&
    content.length <= MAX_CONTENT_LENGTH
  );
}

function normalizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidTurn)
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .slice(-MAX_MESSAGES);
}

/** POST /api/chat — AI support reply for the betting site widget. */
export async function postChatMessage(req: Request, res: Response): Promise<void> {
  try {
    const history = normalizeHistory(req.body?.messages);

    if (history.length === 0) {
      res.status(400).json({ error: 'At least one message is required' });
      return;
    }

    const last = history[history.length - 1];
    if (last.role !== 'user') {
      res.status(400).json({ error: 'The latest message must be from the user' });
      return;
    }

    const reply = await getGroqChatReply(history);
    res.json({ reply });
  } catch (err) {
    console.error('[chat]', err);
    const message = err instanceof Error ? err.message : 'Chat request failed';
    const isConfig = message.includes('GROQ_API_KEY');
    res.status(isConfig ? 503 : 502).json({
      error: isConfig
        ? 'Support chat is temporarily unavailable. Please try again later.'
        : 'Could not get a reply. Please try again.',
    });
  }
}
