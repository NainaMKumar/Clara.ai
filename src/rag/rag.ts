import type { Note } from '../types'
import type { ChatMessage, Citation, ChatResponse, EmbedResponse } from './types'
import { upsertNoteIndex, deleteNoteIndex } from './indexer'
import { normalize } from './vector'
import { vectorSearchTopK, searchMultipleQueries } from './store'

export type RagAnswer = {
  answer: string
  citations: Citation[]
  usedChunkIds: string[]
}

export type { ChatMessage }

async function embedOne(text: string): Promise<number[]> {
  const resp = await fetch('/api/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts: [text] }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Embedding request failed: ${resp.status} ${resp.statusText} ${body}`)
  }
  const data = (await resp.json()) as EmbedResponse
  const vec = data.vectors?.[0]
  if (!vec) throw new Error('Embedding API returned no vector')
  return vec
}

async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const resp = await fetch('/api/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Embedding request failed: ${resp.status} ${resp.statusText} ${body}`)
  }
  const data = (await resp.json()) as EmbedResponse
  return data.vectors ?? []
}

type ExtractConceptsResponse = {
  concepts: string[]
}

/**
 * Ask the LLM to extract key concepts/entities from initial retrieval results.
 * This enables multi-hop retrieval by expanding the search space.
 */
async function extractKeyConcepts(
  question: string,
  contexts: { noteTitle: string; text: string }[]
): Promise<string[]> {
  const contextSummary = contexts
    .map((c) => `[${c.noteTitle}]: ${c.text.slice(0, 500)}`)
    .join('\n\n')

  const resp = await fetch('/api/extract_concepts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, contextSummary }),
  })
  
  if (!resp.ok) {
    // Fallback: if endpoint doesn't exist or fails, return empty
    return []
  }
  
  const data = (await resp.json()) as ExtractConceptsResponse
  return data.concepts ?? []
}

async function chat(
  question: string,
  contexts: { chunkId: string; noteId: string; noteTitle: string; text: string }[],
  history: ChatMessage[] = []
) {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, contexts, history }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    console.error('Chat request failed:', resp.status, resp.statusText, body)
    throw new Error(`Chat request failed: ${resp.status} ${resp.statusText} ${body}`)
  }
  return (await resp.json()) as ChatResponse
}

export async function upsertNote(note: Note) {
  return await upsertNoteIndex(note)
}

export async function deleteNote(noteId: string) {
  await deleteNoteIndex(noteId)
}

export async function rebuildIndex(notes: Note[]) {
  for (const n of notes) {
    await deleteNoteIndex(n.id)
  }
  for (const n of notes) {
    await upsertNoteIndex(n)
  }
}

/**
 * Ask a question using multi-hop retrieval for deeper context and connections.
 * This is the main entry point - it automatically expands the search to find
 * related concepts across notes.
 */
export async function ask(question: string): Promise<{ answer: RagAnswer; retrieved: Array<{ chunkId: string; noteId: string; noteTitle: string; score: number }> }> {
  const result = await askWithMultiHop(question, [])
  return {
    answer: result.answer,
    retrieved: result.retrieved,
  }
}

/**
 * Ask a question with conversation history for back-and-forth dialogue.
 * Uses multi-hop retrieval to automatically find connections across notes.
 */
export async function askWithHistory(
  question: string,
  history: ChatMessage[]
): Promise<{ answer: RagAnswer; retrieved: Array<{ chunkId: string; noteId: string; noteTitle: string; score: number }> }> {
  const result = await askWithMultiHop(question, history)
  return {
    answer: result.answer,
    retrieved: result.retrieved,
  }
}

/**
 * Simple single-pass retrieval (for cases where speed is more important than depth).
 */
export async function askSimple(
  question: string,
  history: ChatMessage[] = []
): Promise<{ answer: RagAnswer; retrieved: Array<{ chunkId: string; noteId: string; noteTitle: string; score: number }> }> {
  const qVec = normalize(await embedOne(question))
  const retrieved = await vectorSearchTopK({ queryVectorNormalized: qVec, k: 10, minScore: 0.2, maxPerNote: 4 })
  const contexts = retrieved.map((r) => ({ chunkId: r.chunkId, noteId: r.noteId, noteTitle: r.noteTitle, text: r.text }))
  const out = await chat(question, contexts, history)
  return {
    answer: { answer: out.answer, citations: out.citations, usedChunkIds: out.usedChunkIds },
    retrieved: retrieved.map((r) => ({ chunkId: r.chunkId, noteId: r.noteId, noteTitle: r.noteTitle, score: r.score })),
  }
}

/**
 * Multi-hop retrieval: performs two-pass search for deeper context.
 * 
 * Pass 1: Standard vector search on the question
 * Pass 2: Extract key concepts from initial results, then search for those concepts
 * Final: Merge and deduplicate results, then answer with combined context
 * 
 * This is the core retrieval strategy that enables automatic connection-finding
 * across notes by expanding the search based on concepts found in initial results.
 */
async function askWithMultiHop(
  question: string,
  history: ChatMessage[] = []
): Promise<{ 
  answer: RagAnswer
  retrieved: Array<{ chunkId: string; noteId: string; noteTitle: string; score: number }>
  expandedConcepts: string[]
}> {
  // Pass 1: Initial retrieval
  const qVec = normalize(await embedOne(question))
  const pass1Results = await vectorSearchTopK({ 
    queryVectorNormalized: qVec, 
    k: 6, 
    minScore: 0.2, 
    maxPerNote: 3 
  })

  // Extract key concepts for second-pass search
  const concepts = await extractKeyConcepts(
    question,
    pass1Results.map((r) => ({ noteTitle: r.noteTitle, text: r.text }))
  )

  let allRetrieved = [...pass1Results]

  // Pass 2: Search for extracted concepts if we found any
  if (concepts.length > 0) {
    // Embed all concepts
    const conceptVectors = await embedMany(concepts)
    const normalizedConceptVecs = conceptVectors.map(normalize)

    // Search with all concept vectors combined
    const pass2Results = await searchMultipleQueries({
      queryVectorsNormalized: [qVec, ...normalizedConceptVecs],
      k: 10,
      minScore: 0.15, // Slightly lower threshold for expanded search
      maxPerNote: 3,
    })

    // Merge results, keeping unique chunks with best scores
    const seenChunks = new Set(pass1Results.map((r) => r.chunkId))
    for (const r of pass2Results) {
      if (!seenChunks.has(r.chunkId)) {
        seenChunks.add(r.chunkId)
        allRetrieved.push(r)
      }
    }
  }

  // Sort by score and take top results
  allRetrieved.sort((a, b) => b.score - a.score)
  const topRetrieved = allRetrieved.slice(0, 12)

  const contexts = topRetrieved.map((r) => ({ 
    chunkId: r.chunkId, 
    noteId: r.noteId, 
    noteTitle: r.noteTitle, 
    text: r.text 
  }))
  
  const out = await chat(question, contexts, history)
  
  return {
    answer: { 
      answer: out.answer, 
      citations: out.citations, 
      usedChunkIds: out.usedChunkIds 
    },
    retrieved: topRetrieved.map((r) => ({ 
      chunkId: r.chunkId, 
      noteId: r.noteId, 
      noteTitle: r.noteTitle, 
      score: r.score 
    })),
    expandedConcepts: concepts,
  }
}


