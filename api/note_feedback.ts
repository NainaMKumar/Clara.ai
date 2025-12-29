import type { NoteFeedbackItem, NoteFeedbackRequest, NoteFeedbackResponse } from './_types'
import { env } from './env'

type TavilySearchResult = {
  title?: string
  url?: string
  content?: string
  score?: number
}

type TavilySearchResponse = {
  results?: TavilySearchResult[]
}

function requiredEnv(name: string): string {
  // Keep consistent with api/providers/openai.ts behavior.
  const val = env[name] ?? (name === 'OPENAI_API_KEY' ? env.VITE_OPENAI_API_KEY : undefined)
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

function getAllowedOrigins(): string[] {
  const raw = env.RAG_ALLOWED_ORIGINS
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function applyCors(req: any, res: any): boolean {
  const allowed = getAllowedOrigins()
  const origin = String(req.headers?.origin ?? '')
  if (allowed.length === 0) {
    // If not configured, don't set CORS headers (safer default).
    return true
  }
  if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'POST,OPTIONS')
    return true
  }
  if (origin) return false
  return true
}

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1)
      try {
        return JSON.parse(slice)
      } catch {
        return null
      }
    }
    return null
  }
}

function clampText(input: unknown, maxChars: number): string {
  return String(input ?? '').slice(0, maxChars)
}

function sanitizeUrl(url: unknown): string {
  const s = String(url ?? '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) return ''
  return s
}

function toFeedbackItemsShape(input: unknown): NoteFeedbackItem[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as Record<string, unknown>
  const itemsRaw = Array.isArray(obj.items) ? obj.items : []

  const out: NoteFeedbackItem[] = []
  for (const it of itemsRaw) {
    if (!it || typeof it !== 'object') continue
    const rec = it as Record<string, unknown>
    const kind = String(rec.kind ?? '')
    if (kind !== 'missing' && kind !== 'inaccurate' && kind !== 'specificity') continue
    const quote = String(rec.quote ?? '').trim()
    const issue = String(rec.issue ?? '').trim()
    const suggestion = String(rec.suggestion ?? '').trim()
    const conf = String(rec.confidence ?? '')
    const confidence = conf === 'low' || conf === 'medium' || conf === 'high' ? conf : 'medium'
    const sourcesRaw = Array.isArray(rec.sources) ? rec.sources : []
    const sources = sourcesRaw
      .map((s) => {
        if (!s || typeof s !== 'object') return null
        const ss = s as Record<string, unknown>
        const title = String(ss.title ?? '').trim()
        const url = sanitizeUrl(ss.url)
        if (!title || !url) return null
        return { title, url }
      })
      .filter((x): x is { title: string; url: string } => x !== null)
      .slice(0, 5)

    if (!quote || !issue || !suggestion) continue
    out.push({ kind, quote, issue, suggestion, confidence, sources })
  }
  return out.slice(0, 24)
}

async function openaiJson(args: {
  apiKey: string
  model: string
  system: string
  user: string
  maxOutputTokens: number
  temperature: number
}): Promise<{ content: string; parsed: unknown | null }> {
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
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`OpenAI chat error: ${resp.status} ${resp.statusText} ${body}`)
  }

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = String(data.choices?.[0]?.message?.content ?? '')
  const parsed = tryParseJson(content)
  return { content, parsed }
}

async function tavilySearch(args: {
  apiKey: string
  query: string
  maxResults: number
}): Promise<Array<{ title: string; url: string; content: string }>> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: args.apiKey,
      query: args.query,
      max_results: Math.max(1, Math.min(6, Math.floor(args.maxResults))),
      include_answer: false,
      include_images: false,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Tavily search error: ${resp.status} ${resp.statusText} ${body}`)
  }

  const data = (await resp.json()) as TavilySearchResponse
  const results = Array.isArray(data.results) ? data.results : []
  return results
    .map((r) => {
      const title = String(r.title ?? '').trim()
      const url = sanitizeUrl(r.url)
      const content = String(r.content ?? '').trim()
      if (!title || !url || !content) return null
      return { title, url, content }
    })
    .filter((x): x is { title: string; url: string; content: string } => x !== null)
    .slice(0, 6)
}

export default async function handler(req: any, res: any) {
  if (!applyCors(req, res)) {
    return sendJson(res, 403, { error: 'Origin not allowed' })
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    return sendJson(res, 405, { error: 'Method not allowed' })
  }

  try {
    const body = (req.body || {}) as NoteFeedbackRequest
    const noteId = String(body.noteId ?? '').trim()
    const title = clampText(body.title ?? '', 200).trim()
    const contentText = clampText(body.contentText ?? '', 20_000).trim()
    if (!noteId) return sendJson(res, 400, { error: 'noteId is required' })
    if (!contentText) return sendJson(res, 400, { error: 'contentText is required' })

    const openaiKey = requiredEnv('OPENAI_API_KEY')
    const tavilyKey = requiredEnv('TAVILY_API_KEY')
    const model = env.OPENAI_CHAT_MODEL || 'gpt-4o-mini'

    // 1) Ask OpenAI for 2–3 good search queries.
    const querySystem = [
      'You generate web search queries to verify claims in a note.',
      'Return ONLY valid JSON with this exact shape:',
      '{ "queries": string[] }',
      'Rules:',
      '- Provide 2 to 3 queries.',
      '- Each query should be specific and focused on verifying one key claim.',
      '- Avoid overly broad queries.',
    ].join('\n')
    const queryUser = [
      `NOTE_ID: ${noteId}`,
      title ? `TITLE: ${title}` : 'TITLE: (none)',
      '',
      'NOTE_TEXT:',
      contentText,
    ].join('\n')

    const queryOut = await openaiJson({
      apiKey: openaiKey,
      model,
      system: querySystem,
      user: queryUser,
      maxOutputTokens: 180,
      temperature: 0.2,
    })

    const queriesRaw =
      queryOut.parsed && typeof queryOut.parsed === 'object'
        ? (queryOut.parsed as any).queries
        : []
    const queries = (Array.isArray(queriesRaw) ? queriesRaw : [])
      .map((q) => String(q ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)

    // Fallback so the endpoint is robust even if model output is empty.
    const finalQueries = queries.length ? queries : [title || 'verify claims in note']

    // 2) Fetch sources via Tavily.
    const sourcesRaw: Array<{ title: string; url: string; content: string }> = []
    for (const q of finalQueries) {
      const results = await tavilySearch({ apiKey: tavilyKey, query: q, maxResults: 5 })
      for (const r of results) sourcesRaw.push(r)
      if (sourcesRaw.length >= 10) break
    }

    const sources = sourcesRaw
      .slice(0, 10)
      .map((s) => ({
        title: clampText(s.title, 160).trim(),
        url: s.url,
        snippet: clampText(s.content, 1000).trim(),
      }))
      .filter((s) => s.title && s.url && s.snippet)

    // 3) Ask OpenAI for structured critique.
    const critiqueSystem = [
      'You critique a student note for precision and correctness.',
      'You may use the provided web sources to verify claims.',
      'Return ONLY valid JSON with this exact shape:',
      '{ "items": Array<{',
      '  "kind": "missing" | "inaccurate" | "specificity",',
      '  "quote": string,',
      '  "issue": string,',
      '  "suggestion": string,',
      '  "confidence": "low" | "medium" | "high",',
      '  "sources": Array<{ "title": string, "url": string }>',
      '}> }',
      'Rules:',
      '- quote MUST be an exact substring from NOTE_TEXT (keep it short).',
      '- For kind="missing": quote should be the relevant surrounding text (or a short representative sentence).',
      '- For kind="specificity": identify vague terms and suggest what to add (numbers, dates, definitions, examples).',
      '- For kind="inaccurate": only flag if sources strongly contradict or note makes a concrete factual claim. Include 1–3 sources.',
      '- Prefer at most 8 items total.',
    ].join('\n')

    const sourcesBlock = sources
      .map((s, idx) =>
        [
          `SOURCE_${idx + 1}:`,
          `title: ${s.title}`,
          `url: ${s.url}`,
          `snippet: ${s.snippet}`,
        ].join('\n')
      )
      .join('\n\n---\n\n')

    const critiqueUser = [
      `NOTE_ID: ${noteId}`,
      title ? `TITLE: ${title}` : 'TITLE: (none)',
      '',
      'NOTE_TEXT:',
      contentText,
      '',
      'WEB_SOURCES:',
      sourcesBlock || '(none)',
    ].join('\n')

    const critiqueOut = await openaiJson({
      apiKey: openaiKey,
      model,
      system: critiqueSystem,
      user: critiqueUser,
      maxOutputTokens: 900,
      temperature: 0.2,
    })

    const items = toFeedbackItemsShape(critiqueOut.parsed)
      // Ensure quote actually appears in the note.
      .filter((it) => contentText.includes(it.quote))

    const out: NoteFeedbackResponse = {
      items,
      provider: 'openai',
      model,
    }

    return sendJson(res, 200, out)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return sendJson(res, 500, { error: msg })
  }
}


