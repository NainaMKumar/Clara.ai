import type { ChatMessage, ChatResponse, EmbedResponse, RagProvider } from '../_types'

export type ProviderContext = {
  provider: RagProvider
  embedModel: string
  chatModel: string
}

export type CreateEmbeddingsFn = (texts: string[]) => Promise<EmbedResponse>
export type CreateChatFn = (args: {
  question: string
  contexts: { chunkId: string; noteId: string; noteTitle: string; text: string }[]
  history?: ChatMessage[]
  maxOutputTokens: number
}) => Promise<ChatResponse>

export type RagProviderApi = {
  ctx: ProviderContext
  createEmbeddings: CreateEmbeddingsFn
  createChat: CreateChatFn
}


