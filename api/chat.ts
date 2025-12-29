import type { ChatRequest, ChatResponse, RetrievedChunk } from './_types';
import { env } from './env';
import { openaiProvider } from './providers/openai';

function getAllowedOrigins(): string[] {
  const raw = env.RAG_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyCors(req: any, res: any): boolean {
  const allowed = getAllowedOrigins();
  const origin = String(req.headers?.origin ?? '');
  if (allowed.length === 0) {
    // If not configured, don't set CORS headers (safer default).
    return true;
  }
  if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
    return true;
  }
  if (origin) return false;
  return true;
}

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function clampContexts(contexts: RetrievedChunk[]): RetrievedChunk[] {
  const maxContexts = 10;
  const maxCharsPer = 2500;
  const maxTotalChars = 20000;

  const out: RetrievedChunk[] = [];
  let total = 0;

  for (const c of contexts.slice(0, maxContexts)) {
    const text = String(c.text ?? '').slice(0, maxCharsPer);
    const nextTotal = total + text.length;
    if (nextTotal > maxTotalChars) break;
    out.push({
      chunkId: String(c.chunkId ?? ''),
      noteId: String(c.noteId ?? ''),
      noteTitle: String(c.noteTitle ?? ''),
      text,
    });
    total = nextTotal;
  }

  return out.filter((c) => c.chunkId && c.noteId && c.text);
}

export default async function handler(req: any, res: any) {
  if (!applyCors(req, res)) {
    return sendJson(res, 403, { error: 'Origin not allowed' });
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = (req.body || {}) as ChatRequest;
    const question = String(body.question ?? '').trim();
    if (!question) return sendJson(res, 400, { error: 'question is required' });

    const contexts = clampContexts(
      Array.isArray(body.contexts) ? body.contexts : []
    );
    const maxOutputTokens =
      typeof body.options?.maxOutputTokens === 'number' &&
      Number.isFinite(body.options.maxOutputTokens)
        ? Math.max(64, Math.min(1024, Math.floor(body.options.maxOutputTokens)))
        : 400;

    const api = openaiProvider();
    const out: ChatResponse = await api.createChat({
      question,
      contexts,
      maxOutputTokens,
    });

    return sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return sendJson(res, 500, { error: msg });
  }
}
