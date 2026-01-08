export interface Folder {
  id: string
  name: string
  color?: string
  createdDate: string
}

export interface RecordedWaveform {
  id: string
  data: number[]
  duration: number // in seconds
  recordedAt: string // ISO timestamp
}

export interface Note {
  id: string
  title: string
  content: string
  date: string
  folderId?: string
  waveforms?: RecordedWaveform[]
}

export type NoteFeedbackKind = 'missing' | 'inaccurate' | 'specificity'

export type NoteFeedbackSource = {
  title: string
  url: string
}

export type NoteFeedbackItem = {
  kind: NoteFeedbackKind
  quote: string
  issue: string
  suggestion: string
  confidence: 'low' | 'medium' | 'high'
  sources: NoteFeedbackSource[]
}

export type NoteFeedbackResponse = {
  items: NoteFeedbackItem[]
  provider: string
  model: string
}

export type NoteFeedbackFixMode = 'insert' | 'replace'

export type NoteFeedbackFixResponse = {
  mode: NoteFeedbackFixMode
  fixText: string
  provider: string
  model: string
}

export type NoteFeedbackFixContext = {
  containerType?: string
  listType?: 'bulletList' | 'orderedList'
  blockText?: string
}

