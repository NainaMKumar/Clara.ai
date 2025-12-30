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

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatRequest = {
  question: string;
  contexts: RetrievedChunk[];
  history?: ChatMessage[];
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

// --- Extract Concepts (for multi-hop retrieval) ---

export type ExtractConceptsRequest = {
  question: string;
  contextSummary: string;
};

export type ExtractConceptsResponse = {
  concepts: string[];
  provider: RagProvider;
  model: string;
};

// --- Note Connections (cross-note analysis) ---

export type ConnectionType = 'thematic' | 'contradiction' | 'extension' | 'gap';

export type ConnectionQuote = {
  noteId: string;
  noteTitle: string;
  text: string;
};

export type NoteConnection = {
  type: ConnectionType;
  noteIds: string[];
  noteTitles: string[];
  description: string;
  quotes: ConnectionQuote[];
  insight: string; // The "aha" moment or extrapolation
};

export type NoteConnectionsRequest = {
  noteIds?: string[]; // If empty/undefined, analyze all indexed notes
  focusNoteId?: string; // Optional: prioritize connections to this note
  maxConnections?: number; // Default: 8
};

export type NoteConnectionsResponse = {
  connections: NoteConnection[];
  analyzedNoteIds: string[];
  provider: RagProvider;
  model: string;
};
