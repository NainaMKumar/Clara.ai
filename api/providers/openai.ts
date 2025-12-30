import type { ChatResponse, Citation, EmbedResponse } from '../_types'
import type { RagProviderApi } from './types'
import { env } from '../env'

function requiredEnv(name: string): string {
  // Dev convenience: if you already had VITE_OPENAI_API_KEY configured from the old client-only setup,
  // allow it to satisfy OPENAI_API_KEY for the server-side gateway.
  const val = env[name] ?? (name === 'OPENAI_API_KEY' ? env.VITE_OPENAI_API_KEY : undefined)
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

function toJsonResponseShape(input: unknown): { answer: string; citations: Citation[] } {
  if (!input || typeof input !== 'object') throw new Error('Model JSON was not an object')
  const obj = input as Record<string, unknown>
  const answer = typeof obj.answer === 'string' ? obj.answer : ''
  const citationsRaw = Array.isArray(obj.citations) ? obj.citations : []
  const citations: Citation[] = citationsRaw
    .map((c) => {
      if (!c || typeof c !== 'object') return null
      const cc = c as Record<string, unknown>
      const chunkId = typeof cc.chunkId === 'string' ? cc.chunkId : ''
      const noteId = typeof cc.noteId === 'string' ? cc.noteId : ''
      const quote = typeof cc.quote === 'string' ? cc.quote : ''
      if (!chunkId || !noteId || !quote) return null
      return { chunkId, noteId, quote }
    })
    .filter((x): x is Citation => x !== null)
  return { answer, citations }
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    // Try to salvage the largest JSON object in the text
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

/**
 * Try to extract the answer text from a potentially malformed/truncated JSON response.
 * This handles cases where the response was cut off mid-JSON.
 */
function extractAnswerFromMalformedJson(text: string): string | null {
  // Try to extract the answer field value using regex
  // Look for "answer": "..." pattern
  const match = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (match && match[1]) {
    // Unescape JSON string escapes
    try {
      return JSON.parse(`"${match[1]}"`)
    } catch {
      // If unescaping fails, return the raw match (better than nothing)
      return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    }
  }
  return null
}

export function openaiProvider(): RagProviderApi {
  const apiKey = requiredEnv('OPENAI_API_KEY')
  const embedModel = env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'
  const chatModel = env.OPENAI_CHAT_MODEL || 'gpt-4o'

  return {
    ctx: { provider: 'openai', embedModel, chatModel },
    async createEmbeddings(texts: string[]): Promise<EmbedResponse> {
      const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: embedModel,
          input: texts,
        }),
      })

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`OpenAI embeddings error: ${resp.status} ${resp.statusText} ${body}`)
      }

      const data = (await resp.json()) as { data: Array<{ embedding: number[] }> }
      const vectors = data.data.map((d) => d.embedding)
      const dim = vectors[0]?.length ?? 0
      return { vectors, dim, provider: 'openai', model: embedModel }
    },

    async createChat(args): Promise<ChatResponse> {
      const { question, contexts, history = [], maxOutputTokens } = args

      // Detect if we have contexts from multiple notes
      const uniqueNotes = new Set(contexts.map((c) => c.noteId))
      const hasMultipleNotes = uniqueNotes.size > 1

      const connectionInstructions = hasMultipleNotes
        ? [
            '',
            'IMPORTANT: You have context from MULTIPLE different notes. Actively look for:',
            '- How ideas from one note relate to, support, or build upon ideas in another',
            '- Contradictions or tensions between notes that are worth highlighting',
            '- Patterns or themes that emerge across the notes',
            '- Insights that only become apparent when combining information from multiple sources',
            'If you discover meaningful connections, explicitly call them out in your answer.',
          ].join('\n')
        : ''

      const system = [
        'You are Clara, a critical thinking assistant for note-taking.',
        '',
        'When answering questions, follow this reasoning process:',
        '1. IDENTIFY: Find relevant information from each note context provided',
        '2. SYNTHESIZE: Look for connections and patterns across different notes',
        '3. ANALYZE: Note any contradictions, gaps, or tensions between sources',
        '4. EXTRAPOLATE: Draw out implications or insights not explicitly stated',
        '5. ANSWER: Provide your response with this deeper analysis woven in',
        connectionInstructions,
        '',
        'Prefer using the provided note contexts when they are relevant and sufficient.',
        'If the contexts are missing or insufficient, you may answer using your general knowledge.',
        'When multiple notes touch on related topics, actively synthesize them and highlight connections.',
        'Don\'t just answer the literal question - if you notice interesting connections or implications, share them.',
        'You are having a conversation with the user. Use the conversation history to provide contextual responses.',
        '',
        'Return ONLY valid JSON with this exact shape:',
        '{ "answer": string, "citations": Array<{ "chunkId": string, "noteId": string, "quote": string }> }',
        'Only include citations for claims that are directly supported by the provided contexts.',
        'Citations must quote exact text snippets from the contexts (short), and chunkId/noteId must match a provided context.',
        'If you answer using general knowledge not found in the contexts, return an empty citations array (do not fabricate citations).',
      ].join('\n')

      const contextBlock = contexts
        .map((c) =>
          [
            `chunkId: ${c.chunkId}`,
            `noteId: ${c.noteId}`,
            `noteTitle: ${c.noteTitle}`,
            `text: ${c.text}`,
          ].join('\n')
        )
        .join('\n\n---\n\n')

      // Build message array with conversation history
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: system },
      ]

      // Add conversation history
      for (const msg of history) {
        messages.push({
          role: msg.role,
          content: msg.content,
        })
      }

      // Add current question with contexts
      const user = [
        'CONTEXTS:',
        contextBlock || '(none)',
        '',
        'QUESTION:',
        question,
      ].join('\n')
      messages.push({ role: 'user', content: user })

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: chatModel,
          messages,
          temperature: 0.2,
          max_completion_tokens: maxOutputTokens,
          response_format: { type: 'json_object' },
        }),
      })

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`OpenAI chat error: ${resp.status} ${resp.statusText} ${body}`)
      }

      const data = (await resp.json()) as {
        choices: Array<{ message: { content: string }; finish_reason?: string }>
      }
      const content = data.choices?.[0]?.message?.content ?? ''
      const finishReason = data.choices?.[0]?.finish_reason
      const parsed = tryParseJson(content)

      if (!parsed) {
        // JSON parsing failed - try to salvage the answer text
        const extracted = extractAnswerFromMalformedJson(content)
        if (extracted) {
          // We got the answer text even though JSON was malformed (likely truncated)
          return {
            answer: extracted,
            citations: [], // Can't reliably parse citations from malformed JSON
            usedChunkIds: contexts.map((c) => c.chunkId),
            provider: 'openai',
            model: chatModel,
          }
        }
        
        // Complete failure - return a user-friendly message, NOT the raw JSON
        const truncationNote = finishReason === 'length' 
          ? ' (response was truncated due to length)' 
          : ''
        return {
          answer: `I had trouble formatting my response${truncationNote}. Please try asking again.`,
          citations: [],
          usedChunkIds: contexts.map((c) => c.chunkId),
          provider: 'openai',
          model: chatModel,
        }
      }

      const shaped = toJsonResponseShape(parsed)
      return {
        answer: shaped.answer || 'I could not produce an answer.',
        citations: shaped.citations,
        usedChunkIds: contexts.map((c) => c.chunkId),
        provider: 'openai',
        model: chatModel,
      }
    },
  }
}


