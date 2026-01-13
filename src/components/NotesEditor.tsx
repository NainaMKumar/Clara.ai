import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import './NotesEditor.css';

import type { Note, RecordedWaveform } from '../types';
import type {
  NoteFeedbackFixContext,
  NoteFeedbackFixResponse,
  NoteFeedbackItem,
  NoteFeedbackResponse,
} from '../types';

type NotesEditorProps = {
  note: Note;
  onUpdate: (fields: Partial<Note>) => void;
  isRagSidebarOpen?: boolean;
};

type TrackedIssue = NoteFeedbackItem & {
  localId: string;
  resolved: boolean;
};

function makeIssueId(it: NoteFeedbackItem) {
  // Stable enough for UI keys; avoids bringing in hashing deps.
  return `${it.kind}:${it.quote}:${it.issue}`.slice(0, 200);
}

function dismissedStorageKey(noteId: string) {
  return `clara_note_feedback_dismissed_v1:${noteId}`;
}

function loadDismissedIds(noteId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissedStorageKey(noteId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x ?? '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

function persistDismissedIds(noteId: string, ids: Set<string>) {
  try {
    // cap size to avoid unbounded growth
    const arr = Array.from(ids).slice(-200);
    localStorage.setItem(dismissedStorageKey(noteId), JSON.stringify(arr));
  } catch {
    // ignore
  }
}

function normalizeForSearch(s: string) {
  // Normalize whitespace + common Unicode punctuation variants so matching is robust.
  // NOTE: Used for search only; do not assume indices map 1:1 to the raw string.
  return String(s ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeWithMap(raw: string): { norm: string; normToRaw: number[] } {
  // Produces a normalized string plus a mapping from each normalized character index -> raw character index.
  // Normalization rules:
  // - curly quotes/dashes -> ascii
  // - lowercasing
  // - collapse any whitespace run into a single space
  let norm = '';
  const normToRaw: number[] = [];

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    // Collapse whitespace runs.
    if (/\s/.test(ch)) {
      const start = i;
      while (i < raw.length && /\s/.test(raw[i])) i++;
      // Only emit a single space if we already have some content and the previous char wasn't a space.
      if (norm.length > 0 && norm[norm.length - 1] !== ' ') {
        norm += ' ';
        normToRaw.push(start);
      }
      continue;
    }

    let out = ch;
    if (out === '“' || out === '”') out = '"';
    else if (out === '‘' || out === '’') out = "'";
    else if (out === '–' || out === '—') out = '-';

    out = out.toLowerCase();
    norm += out;
    normToRaw.push(i);
    i++;
  }

  // Trim trailing space in normalized representation (keep mapping consistent)
  while (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    normToRaw.pop();
  }
  // Trim leading space similarly
  while (norm.startsWith(' ')) {
    norm = norm.slice(1);
    normToRaw.shift();
  }

  return { norm, normToRaw };
}

function toPlainTextContent(
  text: string
): Array<{ type: string; text?: string }> {
  // TipTap/ProseMirror-friendly representation that preserves newlines as hardBreaks.
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out: Array<{ type: string; text?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) out.push({ type: 'text', text: line });
    if (i < lines.length - 1) out.push({ type: 'hardBreak' });
  }
  return out;
}

function toParagraphNodeFromText(text: string) {
  return {
    type: 'paragraph',
    content: toPlainTextContent(text),
  };
}

function findReasonableInsertPosAfterBlock(doc: any, from: number): number {
  // Insert AFTER the surrounding block (paragraph/listItem/heading/etc), not at the exact highlight position.
  // Fallback: end of document.
  try {
    const $pos = doc.resolve(Math.max(0, Math.min(from, doc.content.size)));
    // Find nearest block at/above this position.
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d);
      if (node && node.isBlock) {
        // Position right after this block node.
        const after = $pos.after(d);
        if (Number.isFinite(after)) return after;
      }
    }
  } catch {
    // ignore
  }
  // ProseMirror doc end position (inside the doc node).
  return Math.max(0, doc?.content?.size ?? 0);
}

function getStructuralContextAtPos(
  doc: any,
  from: number
): NoteFeedbackFixContext {
  try {
    const $pos = doc.resolve(Math.max(0, Math.min(from, doc.content.size)));
    // If within a list item, capture list type.
    for (let d = $pos.depth; d >= 1; d--) {
      const node = $pos.node(d);
      const name = node?.type?.name;
      if (name === 'listItem') {
        const parentName = $pos.node(d - 1)?.type?.name;
        const listType =
          parentName === 'bulletList' || parentName === 'orderedList'
            ? parentName
            : undefined;
        const blockText = String(node.textContent ?? '').slice(0, 900);
        return { containerType: 'listItem', listType, blockText };
      }
    }
    // Otherwise nearest block.
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d);
      if (node?.isBlock) {
        return {
          containerType: String(node.type?.name ?? 'block'),
          blockText: String(node.textContent ?? '').slice(0, 900),
        };
      }
    }
  } catch {
    // ignore
  }
  return { containerType: 'unknown' };
}

function getListInsertTarget(
  doc: any,
  from: number
): { pos: number; listType: 'bulletList' | 'orderedList' } | null {
  try {
    const $pos = doc.resolve(Math.max(0, Math.min(from, doc.content.size)));
    for (let d = $pos.depth; d >= 1; d--) {
      const node = $pos.node(d);
      if (node?.type?.name !== 'listItem') continue;
      const parentName = $pos.node(d - 1)?.type?.name;
      if (parentName !== 'bulletList' && parentName !== 'orderedList') continue;
      const posAfterListItem = $pos.after(d); // inside list
      return { pos: posAfterListItem, listType: parentName };
    }
  } catch {
    // ignore
  }
  return null;
}

function findQuoteRangeInDoc(
  doc: any,
  quote: string
): { from: number; to: number } | null {
  const qRaw = String(quote ?? '').trim();
  if (!qRaw) return null;

  let combined = '';
  const charToDocPos: number[] = []; // raw character index -> doc position

  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return true;
    const text = String(node.text ?? '');
    for (let i = 0; i < text.length; i++) {
      combined += text[i];
      charToDocPos.push(pos + i);
    }
    return true;
  });

  if (!combined) return null;

  // Fast path: exact substring (best highlighting).
  const exactIdx = combined.indexOf(qRaw);
  let rawStart: number | null = null;
  let rawEndExclusive: number | null = null;
  if (exactIdx >= 0) {
    rawStart = exactIdx;
    rawEndExclusive = exactIdx + qRaw.length;
  } else {
    // Robust path: normalized search with mapping back to raw indices.
    const hay = normalizeWithMap(combined);
    const qNorm = normalizeForSearch(qRaw);
    if (!qNorm) return null;
    const idx = hay.norm.indexOf(qNorm);
    if (idx < 0) return null;

    const startRaw = hay.normToRaw[idx];
    const endNormIdx = idx + qNorm.length;
    const endRaw =
      endNormIdx < hay.normToRaw.length
        ? hay.normToRaw[endNormIdx]
        : combined.length;

    rawStart = startRaw;
    rawEndExclusive = endRaw;
  }

  if (rawStart === null || rawEndExclusive === null) return null;
  rawStart = Math.max(0, Math.min(rawStart, charToDocPos.length - 1));
  rawEndExclusive = Math.max(
    rawStart + 1,
    Math.min(rawEndExclusive, charToDocPos.length)
  );

  const from = charToDocPos[rawStart];
  const toCharIdx = Math.max(rawStart, rawEndExclusive - 1);
  const to = charToDocPos[toCharIdx];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to: to + 1 };
}

function createGhostTextExtension(
  suggestionRef: React.MutableRefObject<string>
) {
  return Extension.create({
    name: 'ghostText',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations(state) {
              const suggestion = suggestionRef.current;
              // Only show ghost text if we have a suggestion and (in autocomplete mode or suggestion mode)
              // Actually, user wants it for both.
              if (!suggestion) return DecorationSet.empty;

              // In autocomplete mode, we show whatever is in suggestion (transcript).
              // In suggestion mode, we show whatever is in suggestion (AI result).

              const { to } = state.selection;
              const deco = Decoration.widget(
                to,
                () => {
                  const span = document.createElement('span');
                  span.textContent = suggestion;
                  span.className = 'ghost-text';
                  return span;
                },
                { side: 1 }
              );
              return DecorationSet.create(state.doc, [deco]);
            },
          },
        }),
      ];
    },
  });
}

function createFeedbackHighlightExtension(
  issuesRef: React.MutableRefObject<TrackedIssue[]>
) {
  return Extension.create({
    name: 'feedbackHighlight',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations(state: any) {
              const issues = issuesRef.current.filter((x) => !x.resolved);
              if (!issues.length) return null;
              const decos: Decoration[] = [];
              for (const it of issues) {
                const range = findQuoteRangeInDoc(state.doc, it.quote);
                if (!range) continue;
                decos.push(
                  Decoration.inline(range.from, range.to, {
                    class: `note-feedback-highlight note-feedback-highlight--${it.kind}`,
                    'data-feedback-id': it.localId,
                  })
                );
              }
              return DecorationSet.create(state.doc, decos);
            },
          },
        }),
      ];
    },
  });
}

function IconLink() {
  return (
    <svg className='format-icon' viewBox='0 0 24 24' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M10.59 13.41a1.98 1.98 0 0 0 2.82 0l3.54-3.54a2 2 0 1 0-2.83-2.83l-1.06 1.06a1 1 0 1 1-1.41-1.41l1.06-1.06a4 4 0 1 1 5.66 5.66l-3.54 3.54a3.98 3.98 0 0 1-5.64 0a1 1 0 0 1 1.41-1.41ZM13.41 10.59a1.98 1.98 0 0 0-2.82 0L7.05 14.12a2 2 0 1 0 2.83 2.83l1.06-1.06a1 1 0 1 1 1.41 1.41l-1.06 1.06a4 4 0 1 1-5.66-5.66l3.54-3.54a3.98 3.98 0 0 1 5.64 0a1 1 0 0 1-1.41 1.41Z'
      />
    </svg>
  );
}

function IconImage() {
  return (
    <svg className='format-icon' viewBox='0 0 24 24' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M21 5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5Zm-2 0v9.17l-2.59-2.58a2 2 0 0 0-2.82 0L7 18.17V5h12ZM5 19v-1.17l7-7l7 7V19H5Zm4.5-9A1.5 1.5 0 1 0 8 8.5A1.5 1.5 0 0 0 9.5 10Z'
      />
    </svg>
  );
}

function IconCode() {
  return (
    <svg className='format-icon' viewBox='0 0 24 24' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M8.7 16.3a1 1 0 0 1 0 1.4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 1 1 1.4 1.4L5.41 12l3.3 3.3Zm6.6 0L18.59 12l-3.3-3.3a1 1 0 1 1 1.4-1.4l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4 0a1 1 0 0 1 0-1.4ZM10.7 19.6a1 1 0 0 1-.9-1.4l4-14a1 1 0 0 1 1.92.55l-4 14a1 1 0 0 1-1.02.85Z'
      />
    </svg>
  );
}

function IconCodeBlock() {
  return (
    <svg className='format-icon' viewBox='0 0 24 24' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Zm1 2.5L18.5 8H15a1 1 0 0 1-1-1V4.5ZM7 20V4h6v3a3 3 0 0 0 3 3h3v10H7Z'
      />
      <path
        fill='currentColor'
        d='M9.2 15.8a1 1 0 0 1 0-1.4L10.6 13l-1.4-1.4a1 1 0 1 1 1.4-1.4l2.1 2.1a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0Zm5.6 0-2.1-2.1a1 1 0 0 1 0-1.4l2.1-2.1a1 1 0 1 1 1.4 1.4L14.8 13l1.4 1.4a1 1 0 1 1-1.4 1.4Z'
      />
    </svg>
  );
}

function IconQuote() {
  return (
    <svg className='format-icon' viewBox='0 0 24 24' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M7.17 6.17A4 4 0 0 0 5 9.76V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H7.02c.05-1.52.68-2.82 2.15-3.7a1 1 0 1 0-1-1.73Zm10 0A4 4 0 0 0 15 9.76V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-1.98c.05-1.52.68-2.82 2.15-3.7a1 1 0 1 0-1-1.73Z'
      />
    </svg>
  );
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toEditorHtml(content: string) {
  // If it already looks like HTML, keep it; otherwise treat it as plain text.
  const trimmed = content.trim();
  if (trimmed.startsWith('<')) return content;
  if (!trimmed) return '<p></p>';
  return `<p>${escapeHtml(content).replace(/\n/g, '<br />')}</p>`;
}

const NotesEditor: React.FC<NotesEditorProps> = ({ note, onUpdate }) => {
  const [title, setTitle] = useState(note.title);
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const deepgramSocketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  // Audio visualization refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingStartTimeRef = useRef<number>(0);
  // Ref to track accumulated final transcripts (avoids stale closure issues)
  const accumulatedTranscriptRef = useRef<string>('');
  // Track the latest audio timestamp from Deepgram (for filtering old buffered results)
  const latestAudioTimeRef = useRef<number>(0);
  // Cutoff time: ignore any results with start time before this (set when user types)
  const audioCutoffTimeRef = useRef<number>(0);
  // Track last time we received a message from Deepgram (for detecting silent death)
  const lastDeepgramMessageTimeRef = useRef<number>(0);
  // Default to "autocomplete" so users immediately see speech appear in the note as a transcript.
  const [mode, setMode] = useState<'autocomplete' | 'suggestion'>(
    'autocomplete'
  );
  const suggestionRef = useRef('');
  const modeRef = useRef<'autocomplete' | 'suggestion'>('autocomplete');

  // Sync refs for extensions/callbacks
  useEffect(() => {
    suggestionRef.current = suggestion;
  }, [suggestion]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false);
  const [recordingError, setRecordingError] = useState('');
  const [suggestionError, setSuggestionError] = useState('');
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('https://');
  const [linkSelection, setLinkSelection] = useState<{
    from: number;
    to: number;
    empty: boolean;
  } | null>(null);
  const [isImageModalOpen, setIsImageModalOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [imageSelection, setImageSelection] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string>('');
  const [feedbackActionMsg, setFeedbackActionMsg] = useState<string>('');
  const feedbackActionTimerRef = useRef<number | null>(null);
  const [trackedIssues, setTrackedIssues] = useState<TrackedIssue[]>([]);
  const trackedIssuesRef = useRef<TrackedIssue[]>([]);
  const [hasRequestedFeedback, setHasRequestedFeedback] = useState(false);
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  const editorWrapRef = useRef<HTMLDivElement | null>(null);
  const [annotationPins, setAnnotationPins] = useState<
    Array<{ localId: string; top: number; issue: TrackedIssue }>
  >([]);
  const annotationCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const annotationHeightsRef = useRef<Record<string, number>>({});
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  );
  const [activeFixId, setActiveFixId] = useState<string | null>(null);
  const [fixDraftText, setFixDraftText] = useState<string>('');
  const [fixDraftMode, setFixDraftMode] = useState<'insert' | 'replace'>(
    'insert'
  );
  const [isGeneratingFix, setIsGeneratingFix] = useState(false);

  const insertImageAtSelection = async (opts: { src: string }) => {
    if (!editor) return;
    const sel = imageSelection ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    editor
      .chain()
      .focus()
      .setTextSelection(sel)
      .setImage({ src: opts.src })
      .run();
  };

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        Link.configure({
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
        }),
        Image,
        createFeedbackHighlightExtension(trackedIssuesRef),
        createGhostTextExtension(suggestionRef),
      ],
      content: toEditorHtml(note.content),
      editorProps: {
        attributes: {
          class: 'wysiwyg-editor',
          'data-placeholder': 'Start taking notes here...',
          // Disable browser autocorrect/autocapitalize inside the contenteditable editor.
          // This prevents things like automatically changing "i" -> "I".
          autocapitalize: 'off',
          autocomplete: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        },
        handleKeyDown: (view: any, event: any) => {
          // #region agent log
          if (event.key === 'Tab') {
            fetch(
              'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  location: 'NotesEditor.tsx:handleKeyDown-entry',
                  message: 'Tab pressed',
                  data: {
                    suggestionRef: suggestionRef.current,
                    hasText: !!suggestionRef.current?.trim(),
                  },
                  timestamp: Date.now(),
                  sessionId: 'debug-session',
                  hypothesisId: 'TAB',
                }),
              }
            ).catch(() => {});
          }
          // #endregion

          if (event.key === 'Tab' && suggestionRef.current.trim()) {
            event.preventDefault();
            // Accept the suggestion at the current cursor position.
            const suggestionText = suggestionRef.current;
            const { state, dispatch } = view;
            const { to } = state.selection;

            // #region agent log
            fetch(
              'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  location: 'NotesEditor.tsx:tab-handler',
                  message: 'Tab pressed - attempting to insert suggestion',
                  data: {
                    suggestionText,
                    suggestionLength: suggestionText.length,
                    cursorPosition: to,
                    docSize: state.doc.content.size,
                  },
                  timestamp: Date.now(),
                  sessionId: 'debug-session',
                  hypothesisId: 'TAB',
                }),
              }
            ).catch(() => {});
            // #endregion

            try {
              // Create a new transaction and insert text at cursor position
              const tr = state.tr.insertText(suggestionText, to);
              dispatch(tr);

              // #region agent log
              fetch(
                'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    location: 'NotesEditor.tsx:tab-handler-success',
                    message: 'Dispatch completed',
                    data: { newDocSize: view.state.doc.content.size },
                    timestamp: Date.now(),
                    sessionId: 'debug-session',
                    hypothesisId: 'TAB',
                  }),
                }
              ).catch(() => {});
              // #endregion
            } catch (err) {
              // #region agent log
              fetch(
                'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    location: 'NotesEditor.tsx:tab-handler-error',
                    message: 'Dispatch failed',
                    data: { error: String(err) },
                    timestamp: Date.now(),
                    sessionId: 'debug-session',
                    hypothesisId: 'TAB',
                  }),
                }
              ).catch(() => {});
              // #endregion
            }

            setSuggestion('');
            // Reset accumulated transcript - user has "consumed" this text
            // Also set cutoff to ignore any buffered old results
            accumulatedTranscriptRef.current = '';
            audioCutoffTimeRef.current = latestAudioTimeRef.current;
            setTranscript('');
            return true;
          }
          if (event.key === 'Escape' && isLinkModalOpen) {
            event.preventDefault();
            setIsLinkModalOpen(false);
            return true;
          }
          if (event.key === 'Escape' && isImageModalOpen) {
            event.preventDefault();
            setIsImageModalOpen(false);
            return true;
          }
          return false;
        },
        handlePaste: (_view: any, event: any) => {
          // Allow direct image pasting into the editor: insert image at cursor.
          const clipboard = event.clipboardData;
          if (!clipboard) return false;

          const items = Array.from(clipboard.items) as DataTransferItem[];
          const imageItem = items.find(
            (it) => it.kind === 'file' && it.type.startsWith('image/')
          );
          if (!imageItem) return false;

          const file = imageItem.getAsFile();
          if (!file) return false;

          event.preventDefault();
          (async () => {
            try {
              const src = await readFileAsDataUrl(file);
              // Use current selection in editor (no modal needed for paste).
              editor?.chain().focus().setImage({ src }).run();
            } catch (err) {
              console.error('Failed to paste image', err);
            }
          })();
          return true;
        },
      },
      onUpdate: ({ editor }: any) => {
        const html = editor.getHTML();
        onUpdate({ content: html });
        // When user types, reset accumulated transcript - they've "caught up" to this point
        // Also set the audio cutoff time to ignore any buffered old results still coming through
        if (
          accumulatedTranscriptRef.current ||
          latestAudioTimeRef.current > 0
        ) {
          accumulatedTranscriptRef.current = '';
          // Set cutoff to latest audio time - ignore any results from before this point
          audioCutoffTimeRef.current = latestAudioTimeRef.current;
          setTranscript('');
        }
        if (suggestion) setSuggestion('');
      },
    },
    // Recreate editor when switching notes (simplest + avoids content desync).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id]
  );

  // ProseMirror decorations only refresh on transactions. Since ghost text is driven
  // by a ref (not document state), we force a no-op transaction whenever the
  // suggestion changes so the decoration re-renders immediately.
  useEffect(() => {
    if (!editor) return;
    if (!suggestionRef.current) return;
    try {
      editor.view.dispatch(editor.state.tr);
    } catch {
      // ignore
    }
  }, [editor, suggestion]);

  // Force re-render on selection/transaction changes so toolbar toggles reflect stored marks
  // even when the document doesn't change (e.g., bold toggled on an empty editor).
  const [, forceToolbarUpdate] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => forceToolbarUpdate((n) => (n + 1) % 1_000_000);
    editor.on('transaction', bump);
    editor.on('selectionUpdate', bump);
    return () => {
      editor.off('transaction', bump);
      editor.off('selectionUpdate', bump);
    };
  }, [editor]);

  // Keep local state in sync when switching notes.
  useEffect(() => {
    setTitle(note.title);
    setTranscript('');
    setSuggestion('');
    setRecordingError('');
    setSuggestionError('');
    setIsLoadingFeedback(false);
    setFeedbackError('');
    setFeedbackActionMsg('');
    setTrackedIssues([]);
    trackedIssuesRef.current = [];
    setAnnotationPins([]);
    setHasRequestedFeedback(false);
    setActiveAnnotationId(null);
    setActiveFixId(null);
    setFixDraftText('');
    setFixDraftMode('insert');
    setIsGeneratingFix(false);
    if (feedbackActionTimerRef.current) {
      window.clearTimeout(feedbackActionTimerRef.current);
      feedbackActionTimerRef.current = null;
    }
    // If you switch notes mid-recording, stop cleanly.
    if (isRecording) stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    // Stop any active recording when the editor unmounts.
    return () => {
      try {
        stopRecording();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    trackedIssuesRef.current = trackedIssues;
  }, [trackedIssues]);

  const flashFeedbackAction = (msg: string) => {
    setFeedbackActionMsg(msg);
    if (feedbackActionTimerRef.current)
      window.clearTimeout(feedbackActionTimerRef.current);
    feedbackActionTimerRef.current = window.setTimeout(() => {
      setFeedbackActionMsg('');
      feedbackActionTimerRef.current = null;
    }, 2200);
  };

  const highlightQuoteInEditorDom = (quote: string): boolean => {
    if (!editor) return false;
    const q = quote.trim();
    if (!q) return false;

    const root = editor.view.dom as HTMLElement | null;
    if (!root) return false;

    // Collect text nodes in DOM order.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue ?? '';
        return text.trim().length
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    if (!nodes.length) return false;

    // Build a combined string + index mapping into individual text nodes.
    let combined = '';
    const map: Array<{ node: Text; offset: number }> = [];
    for (const n of nodes) {
      const text = n.nodeValue ?? '';
      for (let i = 0; i < text.length; i++) {
        combined += text[i];
        map.push({ node: n, offset: i });
      }
    }

    const idx = combined.indexOf(q);
    if (idx < 0) return false;
    const endIdx = idx + q.length - 1;
    const start = map[idx];
    const end = map[endIdx];
    if (!start || !end) return false;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);

    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);

    // Scroll to selection.
    const targetEl = (end.node.parentElement ??
      start.node.parentElement) as HTMLElement | null;
    targetEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  };

  const locateQuoteInEditorDom = (
    quote: string
  ): { from: number; to: number } | null => {
    if (!editor) return null;
    const q = quote.trim();
    if (!q) return null;

    const root = editor.view.dom as HTMLElement | null;
    if (!root) return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue ?? '';
        return text.trim().length
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    if (!nodes.length) return null;

    let combined = '';
    const map: Array<{ node: Text; offset: number }> = [];
    for (const n of nodes) {
      const text = n.nodeValue ?? '';
      for (let i = 0; i < text.length; i++) {
        combined += text[i];
        map.push({ node: n, offset: i });
      }
    }

    const idx = combined.indexOf(q);
    if (idx < 0) return null;
    const endIdx = idx + q.length - 1;
    const start = map[idx];
    const end = map[endIdx];
    if (!start || !end) return null;

    // Map DOM positions to ProseMirror document positions.
    const from = editor.view.posAtDOM(start.node, start.offset);
    const to = editor.view.posAtDOM(end.node, end.offset + 1);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { from: Math.max(0, from), to: Math.max(0, to) };
  };

  const commitFeedbackFix = (
    it: NoteFeedbackItem,
    suggestionOverride?: string,
    modeOverride?: 'insert' | 'replace'
  ) => {
    if (!editor) return;
    // Prefer doc-based lookup (more robust vs whitespace/DOM differences),
    // fall back to DOM-based lookup if needed.
    const loc =
      findQuoteRangeInDoc(editor.state.doc, it.quote) ??
      locateQuoteInEditorDom(it.quote);
    if (!loc) {
      setFeedbackError(
        'Could not find that quoted text in the editor (it may have changed).'
      );
      return;
    }

    setFeedbackError('');

    const suggestion = (suggestionOverride ?? it.suggestion).trim();
    if (!suggestion) return;

    const mode: 'insert' | 'replace' =
      modeOverride ?? (it.kind === 'inaccurate' ? 'replace' : 'insert');

    if (mode === 'replace') {
      // Replace the quoted claim with the suggested correction.
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: loc.from, to: loc.to },
          toPlainTextContent(suggestion)
        )
        .run();
      flashFeedbackAction('Applied: replaced text (undo with Cmd+Z)');
      return;
    }

    // Insert the suggestion where it makes sense: after the surrounding block (usually the paragraph),
    // as a new paragraph, rather than inline at the highlight location.
    const listTarget = getListInsertTarget(editor.state.doc, loc.from);
    if (listTarget) {
      // Preserve list structure: add a new list item in the same list.
      editor
        .chain()
        .focus()
        .insertContentAt(listTarget.pos, {
          type: 'listItem',
          content: [toParagraphNodeFromText(suggestion)],
        })
        .run();
    } else {
      const insertPos = findReasonableInsertPosAfterBlock(
        editor.state.doc,
        loc.from
      );
      editor
        .chain()
        .focus()
        .insertContentAt(insertPos, toParagraphNodeFromText(suggestion))
        .run();
    }
    flashFeedbackAction('Applied: inserted fix (undo with Cmd+Z)');
  };

  const resolveTrackedIssue = (localId: string) => {
    setTrackedIssues((prev) =>
      prev.map((x) => (x.localId === localId ? { ...x, resolved: true } : x))
    );
    // Keep ref in sync immediately for decoration + pin calculations.
    trackedIssuesRef.current = trackedIssuesRef.current.map((x) =>
      x.localId === localId ? { ...x, resolved: true } : x
    );
    window.requestAnimationFrame(() => computeAnnotationPins());
  };

  const dismissFeedbackItem = (localId: string) => {
    const ids = loadDismissedIds(note.id);
    ids.add(localId);
    persistDismissedIds(note.id, ids);
    resolveTrackedIssue(localId);
    flashFeedbackAction('Dismissed feedback item');
  };

  const openFixReview = (it: TrackedIssue) => {
    setActiveFixId(it.localId);
    setFixDraftMode(it.kind === 'inaccurate' ? 'replace' : 'insert');
    setFixDraftText('');
    setIsGeneratingFix(true);
    flashFeedbackAction('Generating fix…');
    (async () => {
      try {
        const contentText = (editor?.getText() ?? '')
          .replace(/\u00a0/g, ' ')
          .trim()
          .slice(0, 20_000);
        if (!contentText) throw new Error('Note is empty');

        const loc =
          findQuoteRangeInDoc(editor?.state.doc, it.quote) ??
          locateQuoteInEditorDom(it.quote);
        const context = loc
          ? getStructuralContextAtPos(editor?.state.doc, loc.from)
          : { containerType: 'unknown' };

        const resp = await fetch('/api/note_feedback_fix', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            noteId: note.id,
            title,
            contentText,
            item: it,
            preferredMode: it.kind === 'inaccurate' ? 'replace' : 'insert',
            context,
          }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(
            `Fix generation failed: ${resp.status} ${resp.statusText} ${body}`
          );
        }
        const data = (await resp.json()) as NoteFeedbackFixResponse;
        const fixText = String(data.fixText ?? '').trim();
        const mode = data.mode === 'replace' ? 'replace' : 'insert';

        // Only update if this issue is still the active one.
        setActiveFixId((current) => {
          if (current !== it.localId) return current;
          setFixDraftText(fixText || it.suggestion || '');
          setFixDraftMode(mode);
          return current;
        });
        flashFeedbackAction('Fix generated');
      } catch (e) {
        setFixDraftText(it.suggestion ?? '');
        flashFeedbackAction(
          e instanceof Error ? e.message : 'Failed to generate fix'
        );
      } finally {
        setIsGeneratingFix(false);
      }
    })();
  };

  const fetchNoteFeedback = async () => {
    if (isLoadingFeedback) return;
    setHasRequestedFeedback(true);
    setIsLoadingFeedback(true);
    setFeedbackError('');
    try {
      const contentText = (editor?.getText() ?? '')
        .replace(/\u00a0/g, ' ')
        .trim()
        .slice(0, 20_000);
      if (!contentText) {
        setFeedbackError(
          'Add a bit more content to your note so I can critique it.'
        );
        setTrackedIssues([]);
        trackedIssuesRef.current = [];
        setAnnotationPins([]);
        return;
      }

      const resp = await fetch('/api/note_feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          noteId: note.id,
          title: title,
          contentText,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(
          `Feedback request failed: ${resp.status} ${resp.statusText} ${body}`
        );
      }

      const data = (await resp.json()) as NoteFeedbackResponse;
      const items = Array.isArray(data.items) ? data.items : [];
      // Start tracking issues for persistent highlights + right-side annotations.
      const dismissed = loadDismissedIds(note.id);
      const nextIssues = items
        .map((it) => ({ ...it, localId: makeIssueId(it), resolved: false }))
        .filter((it) => !dismissed.has(it.localId));
      setTrackedIssues(nextIssues);
      trackedIssuesRef.current = nextIssues;
      window.requestAnimationFrame(() => computeAnnotationPins());
      flashFeedbackAction(
        items.length
          ? `Found ${items.length} issue${items.length === 1 ? '' : 's'}`
          : 'No issues found'
      );
    } catch (e) {
      setFeedbackError(
        e instanceof Error ? e.message : 'Failed to fetch feedback'
      );
      setTrackedIssues([]);
      trackedIssuesRef.current = [];
      setAnnotationPins([]);
    } finally {
      setIsLoadingFeedback(false);
    }
  };

  const reconcileIssues = () => {
    if (!editor) return;
    const current = trackedIssuesRef.current;
    if (!current.length) return;
    const next = current.map((it) => {
      if (it.resolved) return it;
      const found = findQuoteRangeInDoc(editor.state.doc, it.quote);
      return found ? it : { ...it, resolved: true };
    });
    // Only update state if something changed.
    const changed = next.some((n, i) => n.resolved !== current[i]?.resolved);
    if (changed) setTrackedIssues(next);
  };

  const computeAnnotationPins = () => {
    if (!editor) return;
    const wrap = editorWrapRef.current;
    const sc = editorScrollRef.current;
    if (!wrap || !sc) return;

    const wrapOffsetTop = wrap.offsetTop;
    const scRect = sc.getBoundingClientRect();
    const active = trackedIssuesRef.current.filter((x) => !x.resolved);

    const pins: Array<{ localId: string; top: number; issue: TrackedIssue }> =
      [];
    for (const it of active) {
      const range = findQuoteRangeInDoc(editor.state.doc, it.quote);
      if (!range) continue;
      const coords = editor.view.coordsAtPos(range.from);
      const topInScroll = coords.top - scRect.top + sc.scrollTop;
      const top = Math.max(0, topInScroll - wrapOffsetTop);
      pins.push({ localId: it.localId, top, issue: it });
    }

    // Collision avoidance: use measured card heights when available.
    pins.sort((a, b) => a.top - b.top);
    const minGap = 12;
    for (let i = 1; i < pins.length; i++) {
      const prev = pins[i - 1];
      const prevH = annotationHeightsRef.current[prev.localId] ?? 160;
      const minTop = prev.top + prevH + minGap;
      if (pins[i].top < minTop) pins[i].top = minTop;
    }

    setAnnotationPins(pins);
  };

  useEffect(() => {
    if (!editor) return;
    const onTxn = () => {
      reconcileIssues();
      computeAnnotationPins();
    };
    editor.on('transaction', onTxn);
    return () => {
      editor.off('transaction', onTxn);
    };
  }, [editor]);

  useEffect(() => {
    const sc = editorScrollRef.current;
    if (!sc) return;
    const onScroll = () => computeAnnotationPins();
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => sc.removeEventListener('scroll', onScroll);
  }, [editor]);

  // Listen for feedback request from parent component
  useEffect(() => {
    const handleFeedbackRequest = () => {
      if (!isLoadingFeedback) {
        void fetchNoteFeedback();
      }
    };
    window.addEventListener('clara:request-feedback', handleFeedbackRequest);
    return () => window.removeEventListener('clara:request-feedback', handleFeedbackRequest);
  }, [isLoadingFeedback]);

  // After pins render (and whenever the fix editor opens), measure real card heights and reflow.
  useEffect(() => {
    if (!hasRequestedFeedback) return;
    const raf = window.requestAnimationFrame(() => {
      const next: Record<string, number> = { ...annotationHeightsRef.current };
      let changed = false;
      for (const p of annotationPins) {
        const el = annotationCardRefs.current[p.localId];
        if (!el) continue;
        const h = Math.max(72, Math.round(el.getBoundingClientRect().height));
        if (next[p.localId] !== h) {
          next[p.localId] = h;
          changed = true;
        }
      }
      if (changed) {
        annotationHeightsRef.current = next;
        computeAnnotationPins();
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [annotationPins.length, hasRequestedFeedback, activeFixId]);

  // Auto-highlight (jump to) the first annotation when feedback appears.
  useEffect(() => {
    if (!hasRequestedFeedback) return;
    if (activeAnnotationId) return;
    const first = annotationPins[0];
    if (!first) return;
    setActiveAnnotationId(first.localId);
    // Defer until DOM selection is possible.
    window.requestAnimationFrame(() => {
      highlightQuoteInEditorDom(first.issue.quote);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationPins, hasRequestedFeedback]);

  // Audio waveform visualization - shows entire recording, compressing as it grows
  const drawWaveform = () => {
    const analyser = analyserRef.current;
    if (!analyser) {
      animationFrameRef.current = requestAnimationFrame(drawWaveform);
      return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    // Calculate RMS amplitude for this frame
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / bufferLength);
    const amplitude = Math.min(1, rms * 5); // Scale up for visibility

    // Add new amplitude to waveform history
    // Downsample when data gets very large to prevent memory issues
    setWaveformData(prev => {
      const newData = [...prev, amplitude];
      // If we have too many samples, downsample by averaging pairs
      const maxSamples = 2000;
      if (newData.length > maxSamples) {
        const downsampled: number[] = [];
        for (let i = 0; i < newData.length; i += 2) {
          const avg = (newData[i] + (newData[i + 1] ?? newData[i])) / 2;
          downsampled.push(avg);
        }
        return downsampled;
      }
      return newData;
    });

    // Update recording duration
    if (recordingStartTimeRef.current > 0) {
      const elapsed = Math.floor((Date.now() - recordingStartTimeRef.current) / 1000);
      setRecordingDuration(elapsed);
    }

    animationFrameRef.current = requestAnimationFrame(drawWaveform);
  };

  // Combine saved waveforms + current recording for display
  const savedWaveforms = note.waveforms || [];
  const allWaveformSegments = useMemo(() => {
    const segments: { data: number[]; isCurrent: boolean }[] = [];
    // Add all saved waveforms
    for (const wf of savedWaveforms) {
      segments.push({ data: wf.data, isCurrent: false });
    }
    // Add current recording if active
    if (isRecording && waveformData.length > 0) {
      segments.push({ data: waveformData, isCurrent: true });
    }
    return segments;
  }, [savedWaveforms, isRecording, waveformData]);

  // Calculate total data points across all segments
  const totalDataPoints = useMemo(() => {
    return allWaveformSegments.reduce((sum, seg) => sum + seg.data.length, 0);
  }, [allWaveformSegments]);

  // Separate effect to draw all waveforms on canvas
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    
    // Only draw if there's data to show
    const hasData = allWaveformSegments.length > 0 && totalDataPoints > 0;
    if (!hasData && !isRecording) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerY = height / 2;
    const padding = 4;
    const availableWidth = width - padding * 2;
    const separatorWidth = 3; // Width for vertical separators

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, width, height);

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, centerY);
    ctx.lineTo(width - padding, centerY);
    ctx.stroke();

    if (!hasData) return;

    // Calculate space needed for separators
    const numSeparators = Math.max(0, allWaveformSegments.length - 1);
    const totalSeparatorWidth = numSeparators * separatorWidth;
    const waveformWidth = availableWidth - totalSeparatorWidth;

    // Calculate bar width based on total data points
    const gap = 1;
    let barWidth = (waveformWidth - (totalDataPoints - 1) * gap) / totalDataPoints;
    
    // Clamp bar width
    const minBarWidth = 1;
    const maxBarWidth = 4;
    barWidth = Math.max(minBarWidth, Math.min(maxBarWidth, barWidth));
    
    const stepSize = barWidth + gap;
    const totalUsedWidth = totalDataPoints * stepSize - gap + totalSeparatorWidth;
    const scale = totalUsedWidth > availableWidth ? availableWidth / totalUsedWidth : 1;

    let currentX = padding;
    
    // Draw each segment
    allWaveformSegments.forEach((segment, segIndex) => {
      const { data, isCurrent } = segment;
      
      // Draw separator before this segment (except for first)
      if (segIndex > 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(currentX + separatorWidth / 2, padding + 2);
        ctx.lineTo(currentX + separatorWidth / 2, height - padding - 2);
        ctx.stroke();
        currentX += separatorWidth * scale;
      }
      
      // Draw waveform bars for this segment
      data.forEach((amplitude) => {
        const actualBarWidth = Math.max(1, barWidth * scale);
        const barHeight = Math.max(2, amplitude * (height - padding * 2));
        const y = centerY - barHeight / 2;

        // Different color for saved vs current recording
        if (isCurrent) {
          const intensity = 0.6 + amplitude * 0.4;
          ctx.fillStyle = `rgba(239, 68, 68, ${intensity})`; // Red for current
        } else {
          const intensity = 0.5 + amplitude * 0.3;
          ctx.fillStyle = `rgba(74, 222, 128, ${intensity})`; // Green for saved
        }
        
        ctx.beginPath();
        ctx.roundRect(currentX, y, actualBarWidth, barHeight, actualBarWidth > 2 ? 1 : 0);
        ctx.fill();
        
        currentX += stepSize * scale;
      });
    });

    // Draw playhead at the end if recording
    if (isRecording) {
      const playheadX = Math.min(currentX, width - padding);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, padding);
      ctx.lineTo(playheadX, height - padding);
      ctx.stroke();

      // Small glow effect at playhead
      const glowGradient = ctx.createLinearGradient(playheadX - 20, 0, playheadX, 0);
      glowGradient.addColorStop(0, 'rgba(239, 68, 68, 0)');
      glowGradient.addColorStop(1, 'rgba(239, 68, 68, 0.3)');
      ctx.fillStyle = glowGradient;
      ctx.fillRect(Math.max(padding, playheadX - 20), 0, 20, height);
    }
  }, [allWaveformSegments, totalDataPoints, isRecording]);

  const startAudioVisualization = (stream: MediaStream) => {
    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      setWaveformData([]);
      recordingStartTimeRef.current = Date.now();
      setRecordingDuration(0);

      // Start visualization loop
      drawWaveform();
    } catch (e) {
      console.error('Failed to start audio visualization:', e);
    }
  };

  const stopAudioVisualization = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setWaveformData([]);
    recordingStartTimeRef.current = 0;
    setRecordingDuration(0);
  };

  const handleRecordingToggle = () => {
    if (isRecording || isConnecting) {
      // Stop recording
      stopRecording();
    } else {
      // Start recording
      startRecording();
    }
  };

  const fetchAISuggestion = async (
    typedText: string,
    spokenTranscript: string
  ) => {
    const resp = await fetch('/api/note_suggestion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        typedText,
        spokenTranscript,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Suggestion request failed: ${resp.status} ${resp.statusText} ${body}`
      );
    }
    const data = (await resp.json()) as { suggestion?: string };
    return String(data.suggestion ?? '').trim();
  };

  // Debounced AI suggestion while typing.
  useEffect(() => {
    if (!transcript.trim()) return;

    // In 'suggestion' mode, clear previous suggestion to show loading state/nothing while thinking.
    // In 'autocomplete' mode, keep showing the raw transcript (ghost text) until AI improves it.
    if (mode === 'suggestion') {
      // #region agent log
      fetch(
        'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'NotesEditor.tsx:useEffect-transcript',
            message: 'Transcript changed - clearing suggestion?',
            data: {
              transcriptShort: transcript.slice(-20),
              mode,
              suggestionPresent: !!suggestion,
            },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'UX-FLICKER',
          }),
        }
      ).catch(() => {});
      // #endregion
      // setSuggestion(''); // <--- This causes flickering!
    }

    const timer = window.setTimeout(async () => {
      // current user text
      const currentText = editor?.getText() ?? '';
      const spoken = transcript;
      if ((currentText + spoken).trim().length <= 10) return;

      setIsLoadingSuggestion(true);
      setSuggestionError('');
      try {
        const aiSuggestion = await fetchAISuggestion(currentText, spoken);
        setSuggestion(aiSuggestion);
        setTranscript('');
      } catch (error) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Failed to fetch AI suggestion';
        setSuggestionError(msg);
        console.error('Failed to fetch AI suggestion', error);
      } finally {
        setIsLoadingSuggestion(false);
      }
    }, 1500);

    return () => window.clearTimeout(timer);
  }, [editor, transcript, mode]);

  const startRecording = async () => {
    setRecordingError('');
    setSuggestionError('');
    setIsConnecting(true);

    const DEEPGRAM_API_KEY = String(
      import.meta.env.VITE_DEEPGRAM_API_KEY ?? ''
    ).trim();
    if (!DEEPGRAM_API_KEY) {
      setRecordingError(
        'Missing VITE_DEEPGRAM_API_KEY. Add it to your .env and restart the dev server.'
      );
      setIsConnecting(false);
      return;
    }
    if (!('MediaRecorder' in window)) {
      setRecordingError(
        'This browser does not support audio recording (MediaRecorder unavailable).'
      );
      setIsConnecting(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordingError('This browser does not support microphone recording.');
      setIsConnecting(false);
      return;
    }
    if (
      window.location.protocol !== 'https:' &&
      window.location.hostname !== 'localhost'
    ) {
      setRecordingError('Microphone access requires HTTPS (or localhost).');
      setIsConnecting(false);
      return;
    }

    let stream: MediaStream;
    try {
      // Optional: check permission state if the browser supports it.
      try {
        const perm = await (navigator as any)?.permissions?.query?.({
          name: 'microphone',
        });
        if (perm?.state === 'denied') {
          setRecordingError(
            'Microphone permission is blocked for this site. In your browser, open Site Settings and set Microphone to Allow, then reload.'
          );
          setIsConnecting(false);
          return;
        }
      } catch {
        // ignore
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // DOMException names we commonly see:
      // - NotAllowedError: user/browser blocked permission
      // - NotFoundError: no microphone device
      // - NotReadableError: mic already in use or OS-level block
      // - SecurityError: insecure context, etc.
      const name =
        typeof (e as any)?.name === 'string' ? String((e as any).name) : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setRecordingError(
          'Microphone permission denied. Check: (1) browser site settings for localhost:5173 (Allow mic), and (2) macOS System Settings → Privacy & Security → Microphone (allow your browser), then reload.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setRecordingError(
          'No microphone device found. Plug in/enable a mic and try again.'
        );
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setRecordingError(
          'Microphone is busy or blocked by the OS. Close other apps/tabs using the mic (Zoom/Meet/etc) and try again.'
        );
      } else if (name === 'SecurityError') {
        setRecordingError(
          'Microphone blocked due to browser security policy. Use HTTPS (or localhost) and reload.'
        );
      } else {
        setRecordingError(
          e instanceof Error ? e.message : 'Failed to access microphone'
        );
      }
      setIsConnecting(false);
      return;
    }

    mediaStreamRef.current = stream;
    // Start audio visualization
    startAudioVisualization(stream);
    const audioTrack = stream.getAudioTracks()[0];

    // Warn if the audio track is muted or looks like a virtual device
    if (audioTrack?.muted) {
      const label = audioTrack.label || 'Unknown device';
      setRecordingError(
        `Audio input "${label}" is muted. Please select a real microphone in your browser/OS audio settings, or check that your mic is not muted.`
      );
      stream.getTracks().forEach((t) => t.stop());
      setIsConnecting(false);
      return;
    }

    // Show immediate UI feedback that we are attempting to record.
    setIsRecording(true);

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'NotesEditor.tsx:websocket-connect',
        message: 'Creating Deepgram WebSocket connection',
        data: { timestamp: Date.now() },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'B1',
      }),
    }).catch(() => {});
    // #endregion
    const socket = new WebSocket(
      // Parameters tuned for real-time transcription:
      // - interim_results=true: Get partial transcripts immediately as you speak (fixes speed)
      // - model=nova-3: Deepgram's most accurate speech model (fixes accuracy)
      // - punctuate=true: Add punctuation to transcript
      // - smart_format=true: Format numbers, dates, etc.
      'wss://api.deepgram.com/v1/listen?model=nova-3&language=en&punctuate=true&smart_format=true&interim_results=true',
      ['token', DEEPGRAM_API_KEY]
    );
    deepgramSocketRef.current = socket;

    socket.onerror = (err) => {
      // #region agent log
      fetch(
        'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'NotesEditor.tsx:socket-onerror',
            message: 'WebSocket error occurred',
            data: { error: String(err), timestamp: Date.now() },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'ERR',
          }),
        }
      ).catch(() => {});
      // #endregion
      setRecordingError(
        'Deepgram connection error. Check your API key and network.'
      );
      stopRecording();
    };

    socket.onclose = (ev) => {
      // #region agent log - cleanup health check
      if ((socket as any)._healthCheckInterval) {
        clearInterval((socket as any)._healthCheckInterval);
      }
      // #endregion
      // Check recorder state for reconnection decision (avoid stale closure)
      const recorderActive = mediaRecorderRef.current?.state === 'recording';

      // #region agent log
      fetch(
        'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'NotesEditor.tsx:socket-onclose',
            message: 'WebSocket CLOSED - transcription will stop',
            data: {
              code: ev.code,
              reason: ev.reason,
              wasClean: ev.wasClean,
              recorderActive,
              willReconnect: recorderActive && ev.code !== 1000,
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'H1',
          }),
        }
      ).catch(() => {});
      // #endregion

      // If socket closed unexpectedly while recording, auto-reconnect
      if (recorderActive && ev.code !== 1000) {
        // #region agent log
        fetch(
          'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'NotesEditor.tsx:socket-reconnect',
              message: 'Auto-reconnecting Deepgram socket NOW',
              data: {
                closeCode: ev.code,
                closeReason: ev.reason,
                timestamp: Date.now(),
              },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'RECONNECT-FIX',
            }),
          }
        ).catch(() => {});
        // #endregion

        // Create a new socket and update the ref
        const newSocket = new WebSocket(
          'wss://api.deepgram.com/v1/listen?model=nova-3&language=en&punctuate=true&smart_format=true&interim_results=true',
          ['token', DEEPGRAM_API_KEY]
        );
        deepgramSocketRef.current = newSocket;

        // Re-attach the same handlers to the new socket
        newSocket.onerror = socket.onerror;
        newSocket.onclose = socket.onclose;
        newSocket.onopen = () => {
          // Reset audio cutoff to allow new transcripts through after reconnect
          audioCutoffTimeRef.current = 0;
          lastDeepgramMessageTimeRef.current = Date.now();

          // #region agent log
          fetch(
            'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:socket-reconnected',
                message: 'Deepgram socket reconnected successfully',
                data: { timestamp: Date.now(), audioCutoffReset: true },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'RECONNECT',
              }),
            }
          ).catch(() => {});
          // #endregion
        };
        newSocket.onmessage = socket.onmessage;
        return;
      }

      // If we didn't explicitly stop, surface a reason.
      // Use mediaRecorderRef instead of isRecording state to avoid stale closure issue
      const stillRecording = mediaRecorderRef.current?.state === 'recording';
      if (stillRecording) {
        const msg =
          ev.code === 1000
            ? 'Deepgram connection closed.'
            : `Deepgram connection closed (code ${ev.code}).`;
        setRecordingError(msg);
        stopRecording();
      }
    };

    socket.onopen = () => {
      // #region agent log
      fetch(
        'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'NotesEditor.tsx:socket-onopen',
            message: 'WebSocket opened successfully',
            data: { timestamp: Date.now() },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'B1',
          }),
        }
      ).catch(() => {});
      // #endregion
      setIsConnecting(false);
      setIsRecording(true);
      setTranscript('');
      setSuggestion('');
      // Reset all transcript tracking for new session
      accumulatedTranscriptRef.current = '';
      latestAudioTimeRef.current = 0;
      audioCutoffTimeRef.current = 0;

      // Initialize last message time
      lastDeepgramMessageTimeRef.current = Date.now();

      // #region agent log - periodic health check with silent death detection
      const healthCheckInterval = setInterval(() => {
        const currentSocket = deepgramSocketRef.current;
        const recorder = mediaRecorderRef.current;
        const now = Date.now();
        const timeSinceLastMessage = now - lastDeepgramMessageTimeRef.current;
        const SILENT_DEATH_THRESHOLD_MS = 15000; // 15 seconds without a message = silent death

        fetch(
          'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'NotesEditor.tsx:health-check',
              message: 'Periodic recording health check',
              data: {
                socketReadyState: currentSocket?.readyState,
                socketReadyStateLabel:
                  currentSocket?.readyState === 0
                    ? 'CONNECTING'
                    : currentSocket?.readyState === 1
                    ? 'OPEN'
                    : currentSocket?.readyState === 2
                    ? 'CLOSING'
                    : currentSocket?.readyState === 3
                    ? 'CLOSED'
                    : 'NONE',
                recorderState: recorder?.state,
                accumulatedLength: accumulatedTranscriptRef.current.length,
                audioCutoff: audioCutoffTimeRef.current,
                latestAudioTime: latestAudioTimeRef.current,
                modeRef: modeRef.current,
                timeSinceLastMessage,
                willReconnect: timeSinceLastMessage > SILENT_DEATH_THRESHOLD_MS,
              },
              timestamp: now,
              sessionId: 'debug-session',
              hypothesisId: 'H1-H2-H3-H4',
            }),
          }
        ).catch(() => {});

        // Detect silent death: socket reports OPEN but no messages received for 15+ seconds
        if (
          currentSocket?.readyState === WebSocket.OPEN &&
          timeSinceLastMessage > SILENT_DEATH_THRESHOLD_MS &&
          recorder?.state === 'recording'
        ) {
          // #region agent log
          fetch(
            'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:silent-death-detected',
                message: 'Silent death detected - forcing reconnect',
                data: {
                  timeSinceLastMessage,
                  threshold: SILENT_DEATH_THRESHOLD_MS,
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'H1-FIX',
              }),
            }
          ).catch(() => {});
          // #endregion

          // Force close the dead socket to trigger reconnection
          try {
            currentSocket.close(4000, 'Silent death detected');
          } catch {
            // ignore
          }
        }

        // Stop health check if socket is gone
        if (!currentSocket || currentSocket.readyState !== 1) {
          clearInterval(healthCheckInterval);
        }
      }, 5000); // Check every 5 seconds for faster detection
      // Store interval ID for cleanup
      (socket as any)._healthCheckInterval = healthCheckInterval;
      // #endregion

      let mediaRecorder: MediaRecorder;
      try {
        // Prefer webm if available; Safari may throw here, so fall back.
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      } catch {
        mediaRecorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = mediaRecorder;

      // Track audio chunk count for H2 hypothesis
      let audioChunkCount = 0;
      mediaRecorder.ondataavailable = (event) => {
        audioChunkCount++;
        // Use the ref so we send to the current socket (supports reconnection)
        const currentSocket = deepgramSocketRef.current;
        // #region agent log - log every 50th chunk to avoid spam but track activity
        if (audioChunkCount % 50 === 1) {
          fetch(
            'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:ondataavailable',
                message: 'Audio chunk batch (every 50)',
                data: {
                  chunkNumber: audioChunkCount,
                  dataSize: event.data.size,
                  socketReadyState: currentSocket?.readyState,
                  socketOpen: currentSocket?.readyState === WebSocket.OPEN,
                  recorderState: mediaRecorder.state,
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'H2',
              }),
            }
          ).catch(() => {});
        }
        // #endregion
        try {
          if (
            event.data.size > 0 &&
            currentSocket?.readyState === WebSocket.OPEN
          ) {
            currentSocket.send(event.data);
          }
        } catch {
          // ignore
        }
      };
      mediaRecorder.start(100); // Send data in 100ms chunks for lower latency

      // receive transcription results
      socket.onmessage = (message) => {
        // Update last message time for silent death detection
        lastDeepgramMessageTimeRef.current = Date.now();

        // #region agent log
        const msgReceivedTime = Date.now();
        fetch(
          'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'NotesEditor.tsx:onmessage-timing',
              message: 'Deepgram message received',
              data: { msgReceivedTime },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'B1',
            }),
          }
        ).catch(() => {});
        // #endregion
        try {
          const data = JSON.parse(message.data);
          // Surface Deepgram error payloads (otherwise it just looks like "no transcript").
          const maybeErr =
            (typeof data?.error === 'string' && data.error) ||
            (typeof data?.description === 'string' && data.description) ||
            (typeof data?.message === 'string' && data.message) ||
            '';
          if (data?.type === 'Error' || maybeErr) {
            console.error('Deepgram error:', data);
            setRecordingError(`Deepgram error: ${maybeErr || 'Unknown error'}`);
            stopRecording();
            return;
          }
          // #region agent log
          fetch(
            'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:onmessage-raw',
                message: 'Raw Deepgram data',
                data: {
                  hasChannel: !!data.channel,
                  isFinal: data.is_final,
                  speechFinal: data.speech_final,
                  type: data.type,
                  start: data.start,
                  duration: data.duration,
                  channelKeys: data.channel ? Object.keys(data.channel) : [],
                  alternatives: data.channel?.alternatives,
                  firstAlt: data.channel?.alternatives?.[0],
                  rawDataKeys: Object.keys(data),
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'A1-B1',
              }),
            }
          ).catch(() => {});
          // #endregion
          const transcriptText = String(
            data.channel?.alternatives?.[0]?.transcript ?? ''
          ).trim();
          const isFinal = data.is_final === true;
          const speechFinal = data.speech_final === true;
          const confidence = data.channel?.alternatives?.[0]?.confidence ?? 0;
          const audioStart = typeof data.start === 'number' ? data.start : 0;
          const audioDuration =
            typeof data.duration === 'number' ? data.duration : 0;

          // Track the latest audio time for cutoff calculations
          const audioEndTime = audioStart + audioDuration;
          if (audioEndTime > latestAudioTimeRef.current) {
            latestAudioTimeRef.current = audioEndTime;
          }

          // Filter out old buffered results (from before the user last typed)
          if (audioStart < audioCutoffTimeRef.current) {
            // #region agent log
            fetch(
              'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  location: 'NotesEditor.tsx:cutoff-filter',
                  message: 'Result FILTERED by audio cutoff',
                  data: {
                    audioStart,
                    audioCutoff: audioCutoffTimeRef.current,
                    latestAudioTime: latestAudioTimeRef.current,
                    transcriptText,
                  },
                  timestamp: Date.now(),
                  sessionId: 'debug-session',
                  hypothesisId: 'H3',
                }),
              }
            ).catch(() => {});
            // #endregion
            // This result is for audio from before the cutoff - ignore it
            return;
          }

          // #region agent log
          fetch(
            'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:onmessage',
                message: 'Deepgram transcript received',
                data: {
                  transcriptText,
                  isEmpty: !transcriptText,
                  isFinal,
                  speechFinal,
                  confidence,
                  accumulatedSoFar: accumulatedTranscriptRef.current,
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'A1-B1',
              }),
            }
          ).catch(() => {});
          // #endregion
          if (!transcriptText) return;

          // Use ref for accumulation to avoid stale closure issues with React state.
          // - is_final results: Append to accumulated ref (fires frequently during speech)
          // - Interim results: Show (accumulated + current interim) only if confidence is high enough

          // Minimum confidence threshold to filter out absurd low-confidence interim guesses
          const CONFIDENCE_THRESHOLD = 0.75;

          if (isFinal) {
            // Final result: append to accumulated ref
            // Using is_final (not just speech_final) keeps accumulation current during continuous speech
            const newAccumulated = accumulatedTranscriptRef.current
              ? `${accumulatedTranscriptRef.current} ${transcriptText}`
              : transcriptText;
            accumulatedTranscriptRef.current = newAccumulated;

            // #region agent log
            fetch(
              'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  location: 'NotesEditor.tsx:isFinal-accumulated',
                  message: 'Final transcript - accumulated via ref',
                  data: {
                    modeRefCurrent: modeRef.current,
                    newText: transcriptText,
                    newAccumulated,
                    accumulatedLength: newAccumulated.length,
                    confidence,
                    speechFinal,
                  },
                  timestamp: Date.now(),
                  sessionId: 'debug-session',
                  hypothesisId: 'ACCUM',
                }),
              }
            ).catch(() => {});
            // #endregion

            // Update React state for other consumers
            setTranscript(newAccumulated);

            if (modeRef.current === 'autocomplete') {
              try {
                editor?.chain().focus().run();
              } catch {
                // ignore
              }
              setSuggestion(newAccumulated);
            }
          } else if (confidence >= CONFIDENCE_THRESHOLD) {
            // Interim result with good confidence: show as ghost text for real-time feedback
            const combined = accumulatedTranscriptRef.current
              ? `${accumulatedTranscriptRef.current} ${transcriptText}`
              : transcriptText;

            // #region agent log
            fetch(
              'http://127.0.0.1:7242/ingest/7542c04f-bb28-428b-b4ed-cc597c89d113',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  location: 'NotesEditor.tsx:interim-combined',
                  message:
                    'Interim transcript - showing accumulated + current (high confidence)',
                  data: {
                    accumulated: accumulatedTranscriptRef.current,
                    interim: transcriptText,
                    combined,
                    combinedLength: combined.length,
                    confidence,
                    mode: modeRef.current,
                  },
                  timestamp: Date.now(),
                  sessionId: 'debug-session',
                  hypothesisId: 'ACCUM',
                }),
              }
            ).catch(() => {});
            // #endregion

            if (modeRef.current === 'autocomplete') {
              try {
                editor?.chain().focus().run();
              } catch {
                // ignore
              }
              setSuggestion(combined);
            } else if (modeRef.current === 'suggestion') {
              // In suggestion mode, update transcript state so the gray bar shows interim results
              setTranscript(combined);
            }
          }
          // Low-confidence interim results are ignored to filter out absurd guesses
        } catch (e) {
          console.error('Deepgram message parse failed', e);
        }
      };
    };
  };

  const stopRecording = () => {
    setIsConnecting(false);
    setIsRecording(false);
    
    // Save the waveform data before clearing it
    if (waveformData.length > 0 && recordingDuration > 0) {
      const newWaveform: RecordedWaveform = {
        id: Date.now().toString(),
        data: [...waveformData],
        duration: recordingDuration,
        recordedAt: new Date().toISOString(),
      };
      const existingWaveforms = note.waveforms || [];
      onUpdate({ waveforms: [...existingWaveforms, newWaveform] });
    }
    
    // Stop audio visualization
    stopAudioVisualization();
    if (mediaRecorderRef) {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // close the Deepgram websocket
    if (deepgramSocketRef.current) {
      try {
        deepgramSocketRef.current.close();
      } catch {
        // ignore
      }
      deepgramSocketRef.current = null;
    }

    setTranscript('');
    setSuggestion('');
    // Clear all transcript tracking
    accumulatedTranscriptRef.current = '';
    latestAudioTimeRef.current = 0;
    audioCutoffTimeRef.current = 0;

    console.log('Recording stopped...');
  };

  const canFormat = useMemo(() => !!editor, [editor]);
  const canSubmitLink = useMemo(
    () => linkText.trim().length > 0 && linkUrl.trim().length > 0,
    [linkText, linkUrl]
  );
  const fmtClass = (active: boolean) =>
    `format-button${active ? ' active' : ''}`;

  const preventMenuMouseDown = (e: React.MouseEvent) => {
    // Prevent ProseMirror from losing selection/focus when clicking the bubble menu.
    e.preventDefault();
  };

  const openLinkModal = () => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    setLinkSelection({ from, to, empty });

    if (empty) {
      setLinkText('');
      setLinkUrl('https://');
    } else {
      const selected = editor.state.doc.textBetween(from, to, ' ');
      const previousUrl = editor.getAttributes('link').href as
        | string
        | undefined;
      setLinkText(selected);
      setLinkUrl(previousUrl ?? 'https://');
    }

    setIsLinkModalOpen(true);
  };

  const submitLink = () => {
    if (!editor) return;
    if (!linkSelection) return;
    const href = linkUrl.trim();
    const text = linkText.trim();
    if (!href || !text) return;

    const { from, to, empty } = linkSelection;
    editor.chain().focus().setTextSelection({ from, to }).run();

    if (empty) {
      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: 'text',
            text,
            marks: [{ type: 'link', attrs: { href } }],
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }

    setIsLinkModalOpen(false);
  };

  const openImageModal = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    setImageSelection({ from, to });
    setImageUrl('');
    setIsImageModalOpen(true);
  };

  const submitImageUrl = async () => {
    const src = imageUrl.trim();
    if (!src) return;
    await insertImageAtSelection({ src });
    setIsImageModalOpen(false);
  };

  return (
    <div className='notes-editor'>
      <div className='editor-header'>
        <input
          type='text'
          value={title}
          onChange={(e) => {
            const next = e.target.value;
            setTitle(next);
            onUpdate({ title: next });
          }}
          className='note-title-input'
          placeholder='Note Title'
        />
      </div>
      <div className='editor-content' ref={editorScrollRef}>
        <div className='editor-topbar'>
          <div className='toolbar-group' aria-label='AI modes'>
            <button
              className={`mode-button ${mode === 'autocomplete' ? 'active' : ''}`}
              onClick={() => {
                setMode('autocomplete');
                setSuggestion('');
                setSuggestionError('');
              }}
              title='Autocomplete mode'
              type='button'
            >
              Autocomplete
            </button>

            <button
              className={`mode-button ${mode === 'suggestion' ? 'active' : ''}`}
              onClick={() => {
                setMode('suggestion');
                setSuggestion('');
                setSuggestionError('');
              }}
              title='suggestion mode'
              type='button'
            >
              Suggestion
            </button>
          </div>

          <div className='toolbar-group' aria-label='Recording'>
            <button
              className={`record-button ${isRecording ? 'recording' : ''}`}
              onClick={handleRecordingToggle}
              title={
                isRecording || isConnecting ? 'Stop Recording' : 'Start Recording'
              }
              type='button'
            >
              <span className='record-icon'></span>
              {isConnecting
                ? 'Connecting…'
                : isRecording
                ? 'Stop Recording'
                : 'Start Recording'}
            </button>
          </div>
        </div>

        {/* Audio Waveform Visualization Bubble - Always visible */}
        <div className={`audio-waveform-bubble ${isRecording ? 'is-recording' : ''} ${savedWaveforms.length > 0 ? 'has-recordings' : ''}`} aria-label='Audio waveform visualization'>
          {/* Show header with recording info */}
          <div className='waveform-header'>
            {isRecording ? (
              <span className='waveform-indicator'>
                <span className='waveform-dot'></span>
                REC
              </span>
            ) : savedWaveforms.length > 0 ? (
              <span className='waveform-saved-indicator'>
                <svg className='waveform-check-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                  <polyline points='20 6 9 17 4 12'></polyline>
                </svg>
                {savedWaveforms.length} saved
              </span>
            ) : (
              <svg className='waveform-mic-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                <path d='M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z' />
                <path d='M19 10v2a7 7 0 0 1-14 0v-2' />
                <line x1='12' y1='19' x2='12' y2='23' />
                <line x1='8' y1='23' x2='16' y2='23' />
              </svg>
            )}
            <span className='waveform-time'>
              {(() => {
                const savedDuration = savedWaveforms.reduce((sum, wf) => sum + wf.duration, 0);
                const totalDuration = savedDuration + (isRecording ? recordingDuration : 0);
                const mins = Math.floor(totalDuration / 60);
                const secs = totalDuration % 60;
                return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
              })()}
            </span>
          </div>
          
          {/* Show canvas if we have any waveform data */}
          {(savedWaveforms.length > 0 || isRecording) ? (
            <div className='waveform-canvas-container'>
              <canvas
                ref={waveformCanvasRef}
                className='waveform-canvas'
                width={600}
                height={40}
              />
            </div>
          ) : (
            <div className='waveform-idle-track'>
              <div className='waveform-idle-line'></div>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className='waveform-idle-dot' />
              ))}
            </div>
          )}
        </div>
        {recordingError ? (
          <div className='suggestion-bar floating' role='status' aria-live='polite'>
            {recordingError}
          </div>
        ) : isRecording && mode === 'suggestion' && transcript.trim() ? (
          <div className='suggestion-bar floating' role='status' aria-live='polite'>
            Live transcript: "{transcript.slice(-240)}"
          </div>
        ) : null}
        {editor ? (
          <BubbleMenu
            editor={editor}
            className='bubble-menu'
            options={{
              placement: 'top',
              // Keep the menu snug to the selection (no extra gap).
              offset: 0,
            }}
            shouldShow={({ editor, state }) => {
              if (!editor.isEditable) return false;
              if (!editor.isFocused) return false;
              if (state.selection.empty) return false;
              if (isLinkModalOpen || isImageModalOpen) return false;
              return true;
            }}
          >
            <div className='bubble-menu-inner' aria-label='Formatting'>
              <button
                className={fmtClass(!!editor?.isActive('bold'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleBold().run()}
                title='Bold'
                type='button'
                aria-label='Bold'
                disabled={!canFormat}
              >
                B
              </button>
              <button
                className={fmtClass(!!editor?.isActive('italic'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                title='Italic'
                type='button'
                aria-label='Italic'
                disabled={!canFormat}
              >
                I
              </button>
              <button
                className={fmtClass(!!editor?.isActive('strike'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleStrike().run()}
                title='Strikethrough'
                type='button'
                aria-label='Strikethrough'
                disabled={!canFormat}
              >
                S
              </button>
              <button
                className={fmtClass(!!editor?.isActive('code'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleCode().run()}
                title='Inline code'
                type='button'
                aria-label='Inline code'
                disabled={!canFormat}
              >
                <IconCode />
              </button>
              <button
                className={fmtClass(!!editor?.isActive('link'))}
                onMouseDown={preventMenuMouseDown}
                onClick={openLinkModal}
                title='Link'
                type='button'
                aria-label='Insert link'
                disabled={!canFormat}
              >
                <IconLink />
              </button>
              <div className='bubble-separator' role='separator' />
              <button
                className={fmtClass(!!editor?.isActive('heading', { level: 1 }))}
                onMouseDown={preventMenuMouseDown}
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 1 }).run()
                }
                title='Heading 1'
                type='button'
                aria-label='Heading 1'
                disabled={!canFormat}
              >
                H1
              </button>
              <button
                className={fmtClass(!!editor?.isActive('heading', { level: 2 }))}
                onMouseDown={preventMenuMouseDown}
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 2 }).run()
                }
                title='Heading 2'
                type='button'
                aria-label='Heading 2'
                disabled={!canFormat}
              >
                H2
              </button>
              <button
                className={fmtClass(!!editor?.isActive('heading', { level: 3 }))}
                onMouseDown={preventMenuMouseDown}
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 3 }).run()
                }
                title='Heading 3'
                type='button'
                aria-label='Heading 3'
                disabled={!canFormat}
              >
                H3
              </button>
              <div className='bubble-separator' role='separator' />
              <button
                className={fmtClass(!!editor?.isActive('bulletList'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                title='Bullet list'
                type='button'
                aria-label='Bullet list'
                disabled={!canFormat}
              >
                •
              </button>
              <button
                className={fmtClass(!!editor?.isActive('orderedList'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                title='Numbered list'
                type='button'
                aria-label='Numbered list'
                disabled={!canFormat}
              >
                1.
              </button>
              <button
                className={fmtClass(!!editor?.isActive('blockquote'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
                title='Blockquote'
                type='button'
                aria-label='Blockquote'
                disabled={!canFormat}
              >
                <IconQuote />
              </button>
              <button
                className={fmtClass(!!editor?.isActive('codeBlock'))}
                onMouseDown={preventMenuMouseDown}
                onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
                title='Code block'
                type='button'
                aria-label='Code block'
                disabled={!canFormat}
              >
                <IconCodeBlock />
              </button>
              <button
                className={fmtClass(false)}
                onMouseDown={preventMenuMouseDown}
                onClick={() => {
                  openImageModal();
                }}
                title='Image'
                type='button'
                aria-label='Insert image'
                disabled={!canFormat}
              >
                <IconImage />
              </button>
            </div>
          </BubbleMenu>
        ) : null}
        {(() => {
          const unresolvedCount = trackedIssues.filter(
            (x) => !x.resolved
          ).length;
          const showAnnotations =
            hasRequestedFeedback &&
            (isLoadingFeedback ||
              !!feedbackError ||
              unresolvedCount > 0 ||
              activeFixId !== null);
          if (!showAnnotations) {
            return (
              <div className='wysiwyg-editor-container'>
                <EditorContent editor={editor} />
              </div>
            );
          }

          return (
            <div className='editor-with-annotations' ref={editorWrapRef}>
              <div className='wysiwyg-editor-container'>
                <EditorContent editor={editor} />
              </div>

              <div
                className='note-annotations'
                aria-label='Note feedback annotations'
              >
                {feedbackActionMsg ? (
                  <div
                    className='note-annotations-toast'
                    role='status'
                    aria-live='polite'
                  >
                    {feedbackActionMsg}
                  </div>
                ) : null}

                {feedbackError ? (
                  <div className='note-annotations-error'>{feedbackError}</div>
                ) : null}

                {annotationPins.map((p) => (
                  <div
                    key={p.localId}
                    ref={(el) => {
                      annotationCardRefs.current[p.localId] = el;
                    }}
                    className={`note-annotation note-annotation--${
                      p.issue.kind
                    }${
                      activeAnnotationId === p.localId
                        ? ' note-annotation--active'
                        : ''
                    }`}
                    style={{ top: `${p.top}px` }}
                    role='button'
                    tabIndex={0}
                    aria-label='Note feedback annotation'
                    onClick={() => {
                      setActiveAnnotationId(p.localId);
                      const ok = highlightQuoteInEditorDom(p.issue.quote);
                      if (!ok)
                        setFeedbackError(
                          'Could not find that quoted text in the editor (it may have changed).'
                        );
                      else setFeedbackError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveAnnotationId(p.localId);
                        const ok = highlightQuoteInEditorDom(p.issue.quote);
                        if (!ok)
                          setFeedbackError(
                            'Could not find that quoted text in the editor (it may have changed).'
                          );
                        else setFeedbackError('');
                      }
                    }}
                  >
                    <div className='note-annotation-title'>
                      {p.issue.kind === 'missing'
                        ? 'Missing info'
                        : p.issue.kind === 'inaccurate'
                        ? 'Might be inaccurate'
                        : 'Needs specificity'}
                    </div>
                    <div className='note-annotation-quote'>
                      “{p.issue.quote}”
                    </div>
                    <div className='note-annotation-issue'>{p.issue.issue}</div>
                    <div className='note-annotation-suggestion'>
                      <div className='note-annotation-suggestion-label'>
                        Suggested fix
                      </div>
                      <div className='note-annotation-suggestion-text'>
                        {p.issue.suggestion}
                      </div>
                    </div>

                    {activeFixId === p.localId ? (
                      <div
                        className='note-annotation-fixbox'
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {isGeneratingFix ? (
                          <div
                            className='note-annotation-fixbox-loading'
                            role='status'
                            aria-live='polite'
                          >
                            Generating fix…
                          </div>
                        ) : null}
                        <label className='note-annotation-fixbox-label'>
                          Apply mode
                          <select
                            className='note-annotation-fixbox-select'
                            value={fixDraftMode}
                            onChange={(e) =>
                              setFixDraftMode(
                                e.target.value as 'insert' | 'replace'
                              )
                            }
                            disabled={isGeneratingFix}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value='insert'>
                              Insert after highlight
                            </option>
                            <option value='replace'>
                              Replace highlighted text
                            </option>
                          </select>
                        </label>
                        <label className='note-annotation-fixbox-label'>
                          Fix text
                          <textarea
                            className='note-annotation-fixbox-textarea'
                            value={fixDraftText}
                            onChange={(e) => setFixDraftText(e.target.value)}
                            rows={4}
                            disabled={isGeneratingFix}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </label>
                        <div className='note-annotation-actions'>
                          <button
                            type='button'
                            className='note-annotation-action primary'
                            onClick={() => {
                              commitFeedbackFix(
                                p.issue,
                                fixDraftText,
                                fixDraftMode
                              );
                              setActiveFixId(null);
                              resolveTrackedIssue(p.localId);
                            }}
                            title='Apply this change to the note (undo with Cmd+Z)'
                            disabled={isGeneratingFix || !fixDraftText.trim()}
                          >
                            Apply to note
                          </button>
                          <button
                            type='button'
                            className='note-annotation-action secondary'
                            onClick={() => setActiveFixId(null)}
                            disabled={isGeneratingFix}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className='note-annotation-actions'>
                      <button
                        type='button'
                        className='note-annotation-action primary'
                        onClick={() => openFixReview(p.issue)}
                      >
                        Generate fix
                      </button>
                      <button
                        type='button'
                        className='note-annotation-action subtle'
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          dismissFeedbackItem(p.localId);
                        }}
                        title="Dismiss this feedback item if it doesn't apply"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {isLinkModalOpen ? (
          <div
            className='modal-overlay'
            role='dialog'
            aria-modal='true'
            aria-label='Insert link'
            onMouseDown={() => setIsLinkModalOpen(false)}
          >
            <div
              className='modal-card'
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className='modal-title'>Insert link</div>

              <label className='modal-label'>
                Text
                <input
                  className='modal-input'
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                  placeholder='Link text'
                  autoFocus
                />
              </label>

              <label className='modal-label'>
                URL
                <input
                  className='modal-input'
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder='https://example.com'
                />
              </label>

              <div className='modal-actions'>
                <button
                  className='modal-button secondary'
                  type='button'
                  onClick={() => setIsLinkModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className='modal-button primary'
                  type='button'
                  onClick={submitLink}
                  disabled={!canSubmitLink}
                >
                  Insert
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {isImageModalOpen ? (
          <div
            className='modal-overlay'
            role='dialog'
            aria-modal='true'
            aria-label='Insert image'
            onMouseDown={() => setIsImageModalOpen(false)}
          >
            <div
              className='modal-card'
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className='modal-title'>Insert image</div>

              <label className='modal-label'>
                Upload
                <input
                  className='modal-input'
                  type='file'
                  accept='image/*'
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const src = await readFileAsDataUrl(file);
                      await insertImageAtSelection({ src });
                      setIsImageModalOpen(false);
                    } catch (err) {
                      console.error('Failed to upload image', err);
                    }
                  }}
                />
              </label>

              <label className='modal-label'>
                Or paste / enter URL
                <input
                  className='modal-input'
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder='https://example.com/image.png'
                  onPaste={(e) => {
                    const items = Array.from(
                      e.clipboardData.items
                    ) as DataTransferItem[];
                    const imageItem = items.find(
                      (it) => it.kind === 'file' && it.type.startsWith('image/')
                    );
                    if (!imageItem) return;
                    const file = imageItem.getAsFile();
                    if (!file) return;

                    e.preventDefault();
                    (async () => {
                      try {
                        const src = await readFileAsDataUrl(file);
                        await insertImageAtSelection({ src });
                        setIsImageModalOpen(false);
                      } catch (err) {
                        console.error('Failed to paste image into modal', err);
                      }
                    })();
                  }}
                />
              </label>

              <div className='modal-actions'>
                <button
                  className='modal-button secondary'
                  type='button'
                  onClick={() => setIsImageModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className='modal-button primary'
                  type='button'
                  onClick={submitImageUrl}
                  disabled={!imageUrl.trim()}
                >
                  Insert
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {suggestionError ? (
          <div className='suggestion-bar' role='status' aria-live='polite'>
            {suggestionError}
          </div>
        ) : null}

        {(isLoadingSuggestion || suggestion.trim()) && mode === 'suggestion' ? (
          <div className='suggestion-bar' role='status' aria-live='polite'>
            {isLoadingSuggestion ? (
              <span className='suggestion-muted'>Thinking…</span>
            ) : (
              <>
                <span className='suggestion-muted'>Press Tab to accept:</span>
                <span className='suggestion-text-inline'>{suggestion}</span>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default NotesEditor;
