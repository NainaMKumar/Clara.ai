import type { Note } from '../types'
import type { Citation, ChatResponse, EmbedResponse } from './types'
import { upsertNoteIndex, deleteNoteIndex } from './indexer'
import { normalize } from './vector'
import { vectorSearchTopK } from './store'

export type RagAnswer = {
  answer: string
  citations: Citation[]
  usedChunkIds: string[]
}

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

async function chat(question: string, contexts: { chunkId: string; noteId: string; noteTitle: string; text: string }[]) {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, contexts }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
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

export async function ask(question: string): Promise<{ answer: RagAnswer; retrieved: Array<{ chunkId: string; noteId: string; noteTitle: string; score: number }> }> {
  const qVec = normalize(await embedOne(question))
  const retrieved = await vectorSearchTopK({ queryVectorNormalized: qVec, k: 10, minScore: 0.2, maxPerNote: 4 })
  const contexts = retrieved.map((r) => ({ chunkId: r.chunkId, noteId: r.noteId, noteTitle: r.noteTitle, text: r.text }))
  const out = await chat(question, contexts)
  return {
    answer: { answer: out.answer, citations: out.citations, usedChunkIds: out.usedChunkIds },
    retrieved: retrieved.map((r) => ({ chunkId: r.chunkId, noteId: r.noteId, noteTitle: r.noteTitle, score: r.score })),
  }
}


