export type RagProvider = 'openai';

export type RetrievedChunk = {
  chunkId: string;
  noteId: string;
  noteTitle: string;
  text: string;
};

export type Citation = {
  chunkId: string;
  noteId: string;
  quote: string;
};

export type EmbedRequest = {
  texts: string[];
};

export type EmbedResponse = {
  vectors: number[][];
  dim: number;
  provider: RagProvider;
  model: string;
};

export type ChatRequest = {
  question: string;
  contexts: RetrievedChunk[];
  options?: {
    maxOutputTokens?: number;
  };
};

export type ChatResponse = {
  answer: string;
  citations: Citation[];
  usedChunkIds: string[];
  provider: RagProvider;
  model: string;
};
