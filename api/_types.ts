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

export type NoteFeedbackKind = 'missing' | 'inaccurate' | 'specificity';

export type NoteFeedbackSource = {
  title: string;
  url: string;
};

export type NoteFeedbackItem = {
  kind: NoteFeedbackKind;
  quote: string;
  issue: string;
  suggestion: string;
  confidence: 'low' | 'medium' | 'high';
  sources: NoteFeedbackSource[];
};

export type NoteFeedbackRequest = {
  noteId: string;
  title: string;
  contentText: string;
};

export type NoteFeedbackResponse = {
  items: NoteFeedbackItem[];
  provider: RagProvider;
  model: string;
};

export type NoteFeedbackFixMode = 'insert' | 'replace';

export type NoteFeedbackFixRequest = {
  noteId: string;
  title: string;
  contentText: string;
  item: NoteFeedbackItem;
  preferredMode?: NoteFeedbackFixMode;
  context?: {
    containerType?: string;
    listType?: 'bulletList' | 'orderedList';
    blockText?: string;
  };
};

export type NoteFeedbackFixResponse = {
  mode: NoteFeedbackFixMode;
  fixText: string;
  provider: RagProvider;
  model: string;
};
