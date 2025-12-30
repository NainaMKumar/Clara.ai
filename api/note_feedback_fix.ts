import type {
  NoteFeedbackFixRequest,
  NoteFeedbackFixResponse,
  NoteFeedbackItem,
} from './_types';
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
  if (allowed.length === 0) return true;
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

function clampText(input: unknown, maxChars: number): string {
  return String(input ?? '').slice(0, maxChars);
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

async function openaiJson(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
}): Promise<unknown | null> {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      temperature: args.temperature,
      max_tokens: args.maxOutputTokens,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `OpenAI chat error: ${resp.status} ${resp.statusText} ${body}`
    );
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = String(data.choices?.[0]?.message?.content ?? '');
  return tryParseJson(content);
}

function toMode(input: unknown): 'insert' | 'replace' {
  const s = String(input ?? '');
  return s === 'replace' ? 'replace' : 'insert';
}

function toFixText(input: unknown): string {
  return String(input ?? '').trim();
}

function safeItem(input: any): NoteFeedbackItem {
  const kind = String(input?.kind ?? '');
  const quote = String(input?.quote ?? '');
  const issue = String(input?.issue ?? '');
  const suggestion = String(input?.suggestion ?? '');
  const confidence = String(input?.confidence ?? 'medium');
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  return {
    kind:
      kind === 'missing' || kind === 'inaccurate' || kind === 'specificity'
        ? kind
        : 'specificity',
    quote,
    issue,
    suggestion,
    confidence:
      confidence === 'low' || confidence === 'medium' || confidence === 'high'
        ? confidence
        : 'medium',
    sources: sources
      .map((s: any) => ({
        title: String(s?.title ?? '').trim(),
        url: String(s?.url ?? '').trim(),
      }))
      .filter((s: any) => s.title && s.url)
      .slice(0, 5),
  };
}

export default async function handler(req: any, res: any) {
  if (!applyCors(req, res))
    return sendJson(res, 403, { error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = (req.body || {}) as NoteFeedbackFixRequest;
    const noteId = String(body.noteId ?? '').trim();
    const title = clampText(body.title ?? '', 200).trim();
    const contentText = clampText(body.contentText ?? '', 20_000).trim();
    const item = safeItem((body as any).item);
    const preferredMode = String((body as any).preferredMode ?? '').trim();
    const ctx = (body as any).context as
      | {
          containerType?: string;
          listType?: 'bulletList' | 'orderedList';
          blockText?: string;
        }
      | undefined;

    if (!noteId) return sendJson(res, 400, { error: 'noteId is required' });
    if (!contentText)
      return sendJson(res, 400, { error: 'contentText is required' });
    if (!item.quote?.trim())
      return sendJson(res, 400, { error: 'item.quote is required' });
    if (!item.issue?.trim())
      return sendJson(res, 400, { error: 'item.issue is required' });

    const apiKey = requiredEnv('OPENAI_API_KEY');
    const model = env.OPENAI_CHAT_MODEL || 'gpt-5.2';

    const system = [
      'You generate a high-quality fix to apply to a student note.',
      'Return ONLY valid JSON with this exact shape:',
      '{ "mode": "insert" | "replace", "fixText": string }',
      'Rules:',
      '- If mode="replace": fixText should replace the quoted text cleanly.',
      '- If mode="insert": fixText should be additive, meant to be inserted as a new block near the highlighted area (not inline).',
      '- Keep fixText concise and in the same writing style as the note.',
      '- Do NOT include markdown fences.',
      '- If web sources are provided (for inaccuracies), align the fix with them.',
      '- If CONTEXT indicates a list item, write fixText as a single list item content (no leading "-" or numbering).',
    ].join('\n');

    const sourcesBlock = (item.sources || [])
      .map((s, i) => `SOURCE_${i + 1}: ${s.title}\nurl: ${s.url}`)
      .join('\n\n');

    const contextBlock = [
      `containerType: ${String(ctx?.containerType ?? '(unknown)')}`,
      `listType: ${String(ctx?.listType ?? '(none)')}`,
      ctx?.blockText
        ? `blockText: ${clampText(ctx.blockText, 900)}`
        : 'blockText: (none)',
    ].join('\n');

    const user = [
      `NOTE_ID: ${noteId}`,
      title ? `TITLE: ${title}` : 'TITLE: (none)',
      '',
      'NOTE_TEXT:',
      contentText,
      '',
      'HIGHLIGHTED_QUOTE (must match note text):',
      item.quote,
      '',
      'ISSUE:',
      item.issue,
      '',
      'CONTEXT (structure near highlight):',
      contextBlock,
      '',
      'ORIGINAL_SUGGESTION (may be rough):',
      item.suggestion,
      '',
      'PREFERRED_MODE:',
      preferredMode || '(none)',
      '',
      'SOURCES (optional):',
      sourcesBlock || '(none)',
    ].join('\n');

    const parsed = await openaiJson({
      apiKey,
      model,
      system,
      user,
      maxOutputTokens: 220,
      temperature: 0.2,
    });

    const mode = toMode(
      (parsed as any)?.mode ??
        (preferredMode === 'replace' ? 'replace' : 'insert')
    );
    const fixText = toFixText((parsed as any)?.fixText ?? item.suggestion);

    const out: NoteFeedbackFixResponse = {
      mode,
      fixText,
      provider: 'openai',
      model,
    };
    return sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return sendJson(res, 500, { error: msg });
  }
}
