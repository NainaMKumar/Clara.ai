import type { ExtractConceptsRequest, ExtractConceptsResponse } from './_types';
import { env } from './env';

function requiredEnv(name: string): string {
  const val =
    env[name] ??
    (name === 'OPENAI_API_KEY' ? env.VITE_OPENAI_API_KEY : undefined);
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

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

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
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
    const body = (req.body || {}) as ExtractConceptsRequest;
    const question = String(body.question ?? '').trim();
    const contextSummary = String(body.contextSummary ?? '').slice(0, 8000);

    if (!question) {
      return sendJson(res, 400, { error: 'question is required' });
    }

    const apiKey = requiredEnv('OPENAI_API_KEY');
    const model = env.OPENAI_CHAT_MODEL || 'gpt-4o';

    const system = [
      'You extract key concepts, entities, and related topics from note contexts.',
      'Given a user question and some context from their notes, identify 2-4 additional search terms',
      'that would help find related information across their notes.',
      '',
      'Focus on:',
      '- Named entities (people, places, concepts, theories)',
      '- Related topics that might contain supporting information',
      '- Terms that could connect to other notes',
      '',
      'Return ONLY valid JSON with this exact shape:',
      '{ "concepts": string[] }',
      '',
      'Rules:',
      '- Return 2-4 short, specific search phrases',
      '- Each concept should be different from the original question',
      '- Focus on what might be in OTHER notes that would be helpful',
    ].join('\n');

    const user = [
      'QUESTION:',
      question,
      '',
      'CONTEXT FROM INITIAL SEARCH:',
      contextSummary || '(none)',
      '',
      'Extract 2-4 additional search concepts:',
    ].join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 150,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new Error(
        `OpenAI chat error: ${resp.status} ${resp.statusText} ${bodyText}`
      );
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = String(data.choices?.[0]?.message?.content ?? '');
    const parsed = tryParseJson(content);

    let concepts: string[] = [];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.concepts)) {
        concepts = obj.concepts
          .map((c) => String(c ?? '').trim())
          .filter(Boolean)
          .slice(0, 4);
      }
    }

    const out: ExtractConceptsResponse = {
      concepts,
      provider: 'openai',
      model,
    };

    return sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return sendJson(res, 500, { error: msg });
  }
}

