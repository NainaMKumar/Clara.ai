import type { EmbedRequest, EmbedResponse } from './_types';
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
  // If there's an Origin header but it's not allowed, reject.
  if (origin) return false;
  return true;
}

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function clampTexts(texts: string[]): string[] {
  // Basic abuse guardrails: cap count + cap size.
  const maxItems = 128;
  const maxChars = 8000;
  return texts
    .slice(0, maxItems)
    .map((t) => String(t ?? '').slice(0, maxChars));
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
    const body = (req.body || {}) as EmbedRequest;
    const texts = clampTexts(Array.isArray(body.texts) ? body.texts : []);
    if (texts.length === 0)
      return sendJson(res, 400, { error: 'texts must be a non-empty array' });

    const api = openaiProvider();
    const out: EmbedResponse = await api.createEmbeddings(texts);
    return sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return sendJson(res, 500, { error: msg });
  }
}
