export type Citation = {
  chunkId: string
  noteId: string
  quote: string
}

export type EmbedResponse = {
  vectors: number[][]
  dim: number
  provider: string
  model: string
}

export type ChatResponse = {
  answer: string
  citations: Citation[]
  usedChunkIds: string[]
  provider: string
  model: string
}


