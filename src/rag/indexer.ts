import type { Note } from '../types'
import { chunkText, sha256Hex, stripHtmlToText } from './chunk'
import { normalize } from './vector'
import type { ChunkRow, NoteMetaRow, VectorRow } from './store'
import { deleteChunks, deleteNote, getChunksByNoteId, getNoteMeta, getVectorById, putChunks, putNoteMeta, putVectors } from './store'

type EmbedApiResponse = {
  vectors: number[][]
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const resp = await fetch('/api/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Embedding request failed: ${resp.status} ${resp.statusText} ${body}`)
  }
  const data = (await resp.json()) as EmbedApiResponse
  return data.vectors
}

function stableChunkId(noteId: string, hash: string, used: Set<string>, chunkIndex: number): string {
  // Prefer stability based on content hash; disambiguate duplicates deterministically.
  let id = `${noteId}:${hash}`
  if (!used.has(id)) {
    used.add(id)
    return id
  }
  id = `${noteId}:${hash}-${chunkIndex}`
  used.add(id)
  return id
}

export async function upsertNoteIndex(note: Note): Promise<{ indexed: boolean; embedded: number; totalChunks: number }> {
  const plain = stripHtmlToText(note.content || '')
  const combined = `${note.title || ''}\n\n${plain}`.trim()
  const noteHash = await sha256Hex(combined)

  const existingMeta = await getNoteMeta(note.id)
  if (existingMeta && existingMeta.noteHash === noteHash) {
    return { indexed: false, embedded: 0, totalChunks: 0 }
  }

  const texts = chunkText(combined)
  const used = new Set<string>()
  const newChunks: ChunkRow[] = []

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]
    const hash = await sha256Hex(text)
    const chunkId = stableChunkId(note.id, hash, used, i)
    newChunks.push({
      chunkId,
      noteId: note.id,
      noteTitle: note.title || 'Untitled Note',
      chunkText: text,
      chunkIndex: i,
      hash,
    })
  }

  const oldChunks = await getChunksByNoteId(note.id)
  const oldIds = new Set(oldChunks.map((c) => c.chunkId))
  const newIds = new Set(newChunks.map((c) => c.chunkId))

  const toDelete: string[] = []
  for (const id of oldIds) if (!newIds.has(id)) toDelete.push(id)

  // Upsert chunk metadata (title/index/text/hash). Vectors are stored separately.
  await putChunks(newChunks)
  if (toDelete.length) await deleteChunks(toDelete)

  // Embed any chunks missing vectors (or whose hash changed but ID stayed same — unlikely but safe).
  const toEmbed: ChunkRow[] = []
  for (const c of newChunks) {
    const existingVector = await getVectorById(c.chunkId)
    if (!existingVector) {
      toEmbed.push(c)
    }
  }

  let embedded = 0
  if (toEmbed.length) {
    // Batch embedding requests to keep payloads reasonable.
    const batchSize = 64
    const vectorRows: VectorRow[] = []
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize)
      const vectors = await embedTexts(batch.map((c) => c.chunkText))
      if (vectors.length !== batch.length) throw new Error('Embedding API returned unexpected number of vectors')
      for (let j = 0; j < batch.length; j++) {
        vectorRows.push({ chunkId: batch[j].chunkId, vector: normalize(vectors[j]) })
      }
      embedded += batch.length
    }
    await putVectors(vectorRows)
  }

  const now = new Date().toISOString()
  const meta: NoteMetaRow = {
    noteId: note.id,
    noteHash,
    updatedAt: now,
    lastIndexedAt: now,
  }
  await putNoteMeta(meta)

  return { indexed: true, embedded, totalChunks: newChunks.length }
}

export async function deleteNoteIndex(noteId: string): Promise<void> {
  await deleteNote(noteId)
}


