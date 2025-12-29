import { cosineSimilarityNormalized } from './vector'

export type NoteMetaRow = {
  noteId: string
  noteHash: string
  updatedAt: string
  lastIndexedAt: string
}

export type ChunkRow = {
  chunkId: string
  noteId: string
  noteTitle: string
  chunkText: string
  chunkIndex: number
  hash: string
}

export type VectorRow = {
  chunkId: string
  vector: number[]
}

export type Retrieved = {
  chunkId: string
  noteId: string
  noteTitle: string
  text: string
  score: number
}

const DB_NAME = 'clara_rag'
const DB_VERSION = 1

type RagDb = IDBDatabase

let dbPromise: Promise<RagDb> | null = null

function openDb(): Promise<RagDb> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result

      if (!db.objectStoreNames.contains('notes_meta')) {
        db.createObjectStore('notes_meta', { keyPath: 'noteId' })
      }

      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: 'chunkId' })
        store.createIndex('by_noteId', 'noteId', { unique: false })
      }

      if (!db.objectStoreNames.contains('vectors')) {
        db.createObjectStore('vectors', { keyPath: 'chunkId' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(mode: IDBTransactionMode, fn: (stores: {
  notesMeta: IDBObjectStore
  chunks: IDBObjectStore
  vectors: IDBObjectStore
}) => Promise<T>): Promise<T> {
  const db = await openDb()
  return await new Promise<T>((resolve, reject) => {
    const t = db.transaction(['notes_meta', 'chunks', 'vectors'], mode)
    const stores = {
      notesMeta: t.objectStore('notes_meta'),
      chunks: t.objectStore('chunks'),
      vectors: t.objectStore('vectors'),
    }

    fn(stores)
      .then((out) => {
        t.oncomplete = () => resolve(out)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      })
      .catch(reject)
  })
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getNoteMeta(noteId: string): Promise<NoteMetaRow | undefined> {
  return await tx('readonly', async ({ notesMeta }) => {
    const out = await reqToPromise(notesMeta.get(noteId))
    return out as NoteMetaRow | undefined
  })
}

export async function putNoteMeta(row: NoteMetaRow): Promise<void> {
  await tx('readwrite', async ({ notesMeta }) => {
    notesMeta.put(row)
  })
}

export async function getChunksByNoteId(noteId: string): Promise<ChunkRow[]> {
  return await tx('readonly', async ({ chunks }) => {
    const index = chunks.index('by_noteId')
    const out = await reqToPromise(index.getAll(noteId))
    return (out as ChunkRow[]) ?? []
  })
}

export async function putChunks(rows: ChunkRow[]): Promise<void> {
  if (rows.length === 0) return
  await tx('readwrite', async ({ chunks }) => {
    for (const row of rows) chunks.put(row)
  })
}

export async function deleteChunks(chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return
  await tx('readwrite', async ({ chunks, vectors }) => {
    for (const id of chunkIds) {
      chunks.delete(id)
      vectors.delete(id)
    }
  })
}

export async function putVectors(rows: VectorRow[]): Promise<void> {
  if (rows.length === 0) return
  await tx('readwrite', async ({ vectors }) => {
    for (const row of rows) vectors.put(row)
  })
}

export async function deleteNote(noteId: string): Promise<void> {
  await tx('readwrite', async ({ notesMeta, chunks, vectors }) => {
    const index = chunks.index('by_noteId')
    const chunkRows = (await reqToPromise(index.getAll(noteId))) as ChunkRow[]
    for (const c of chunkRows) {
      chunks.delete(c.chunkId)
      vectors.delete(c.chunkId)
    }
    notesMeta.delete(noteId)
  })
}

export async function getAllVectors(): Promise<VectorRow[]> {
  return await tx('readonly', async ({ vectors }) => {
    const out = await reqToPromise(vectors.getAll())
    return (out as VectorRow[]) ?? []
  })
}

export async function getAllChunks(): Promise<ChunkRow[]> {
  return await tx('readonly', async ({ chunks }) => {
    const out = await reqToPromise(chunks.getAll())
    return (out as ChunkRow[]) ?? []
  })
}

export async function getChunkById(chunkId: string): Promise<ChunkRow | undefined> {
  return await tx('readonly', async ({ chunks }) => {
    const out = await reqToPromise(chunks.get(chunkId))
    return out as ChunkRow | undefined
  })
}

export async function getVectorById(chunkId: string): Promise<VectorRow | undefined> {
  return await tx('readonly', async ({ vectors }) => {
    const out = await reqToPromise(vectors.get(chunkId))
    return out as VectorRow | undefined
  })
}

export async function vectorSearchTopK(args: {
  queryVectorNormalized: number[]
  k: number
  minScore?: number
  maxPerNote?: number
}): Promise<Retrieved[]> {
  const { queryVectorNormalized, k, minScore = 0.2, maxPerNote = 4 } = args
  const vectors = await getAllVectors()
  const chunks = await getAllChunks()
  const chunkById = new Map<string, ChunkRow>(chunks.map((c) => [c.chunkId, c]))

  const scored = vectors
    .map((v) => ({
      chunkId: v.chunkId,
      score: cosineSimilarityNormalized(queryVectorNormalized, v.vector),
    }))
    .filter((x) => Number.isFinite(x.score) && x.score >= minScore)
    .sort((a, b) => b.score - a.score)

  const results: Retrieved[] = []
  const perNote = new Map<string, number>()

  for (const s of scored) {
    if (results.length >= k) break
    const chunk = chunkById.get(s.chunkId)
    if (!chunk) continue
    const count = perNote.get(chunk.noteId) ?? 0
    if (count >= maxPerNote) continue
    perNote.set(chunk.noteId, count + 1)

    results.push({
      chunkId: chunk.chunkId,
      noteId: chunk.noteId,
      noteTitle: chunk.noteTitle,
      text: chunk.chunkText,
      score: s.score,
    })
  }

  return results
}


