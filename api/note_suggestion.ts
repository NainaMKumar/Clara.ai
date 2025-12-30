import { env } from './env'

type NoteSuggestionRequest = {
  typedText?: string
  spokenTranscript?: string
  maxOutputTokens?: number
}

type NoteSuggestionResponse = {
  suggestion: string
  provider: 'openai'
  model: string
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

function clampText(input: unknown, maxChars: number): string {
  return String(input ?? '').slice(0, maxChars)
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
    const body = (req.body || {}) as NoteSuggestionRequest
    const typedText = clampText(body.typedText ?? '', 12_000)
    const spokenTranscript = clampText(body.spokenTranscript ?? '', 12_000)

    // This endpoint is meant for "continue what the user was saying" suggestions.
    if (!typedText.trim() && !spokenTranscript.trim()) {
      return sendJson(res, 200, { suggestion: '', provider: 'openai', model: env.OPENAI_CHAT_MODEL || 'gpt-4o-mini' })
    }

    const apiKey = requiredEnv('OPENAI_API_KEY')
    const model = env.OPENAI_CHAT_MODEL || 'gpt-4o-mini'
    const maxOutputTokens =
      typeof body.maxOutputTokens === 'number' && Number.isFinite(body.maxOutputTokens)
        ? Math.max(16, Math.min(220, Math.floor(body.maxOutputTokens)))
        : 120

    const system = [
      'You help complete text for a note-taking app.',
      'The user is recording audio and typing notes at the same time.',
      'Given what was spoken and what has already been typed, output ONLY the remaining words they spoke but have not typed yet.',
      'Rules:',
      '- Do not repeat anything already present in typedText.',
      '- Do not rephrase or summarize.',
      '- Output plain text only (no quotes, no markdown).',
      '- If there is nothing to add, output an empty string.',
    ].join('\n')

    const user = [
      `spokenTranscript: ${spokenTranscript}`,
      `typedText: ${typedText}`,
      '',
      'Only output the remaining words:',
    ].join('\n')

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
        temperature: 0.2,
        max_tokens: maxOutputTokens,
      }),
    })

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '')
      throw new Error(`OpenAI chat error: ${resp.status} ${resp.statusText} ${bodyText}`)
    }

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const suggestion = String(data.choices?.[0]?.message?.content ?? '').trim()

    const out: NoteSuggestionResponse = {
      suggestion,
      provider: 'openai',
      model,
    }
    return sendJson(res, 200, out)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return sendJson(res, 500, { error: msg })
  }
}


