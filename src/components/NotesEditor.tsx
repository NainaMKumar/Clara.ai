import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import './NotesEditor.css';

import type { Note } from '../types';
import type {
  NoteFeedbackFixContext,
  NoteFeedbackFixResponse,
  NoteFeedbackItem,
  NoteFeedbackResponse,
} from '../types';

type NotesEditorProps = {
  note: Note;
  onUpdate: (fields: Partial<Note>) => void;
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
              // #region agent log
              fetch(
                'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    location: 'NotesEditor.tsx:decorations',
                    message: 'Decoration function called',
                    data: {
                      suggestion,
                      hasValue: !!suggestion,
                      selectionTo: state.selection.to,
                    },
                    timestamp: Date.now(),
                    sessionId: 'debug-session',
                    hypothesisId: 'D',
                  }),
                }
              ).catch(() => {});
              // #endregion
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
                  // #region agent log
                  fetch(
                    'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        location: 'NotesEditor.tsx:widget-factory',
                        message: 'Creating ghost span',
                        data: { textContent: suggestion },
                        timestamp: Date.now(),
                        sessionId: 'debug-session',
                        hypothesisId: 'D',
                      }),
                    }
                  ).catch(() => {});
                  // #endregion
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
  // Default to "autocomplete" so users immediately see speech appear in the note as a transcript.
  const [mode, setMode] = useState<'autocomplete' | 'suggestion'>(
    'autocomplete'
  );
  const suggestionRef = useRef('');
  const modeRef = useRef<'autocomplete' | 'suggestion'>('autocomplete');

  // Sync refs for extensions/callbacks
  useEffect(() => {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'NotesEditor.tsx:syncRef',
        message: 'Syncing suggestionRef',
        data: { oldValue: suggestionRef.current, newValue: suggestion },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'C',
      }),
    }).catch(() => {});
    // #endregion
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
        handleKeyDown: (_view: any, event: any) => {
          if (event.key === 'Tab' && suggestionRef.current.trim()) {
            event.preventDefault();
            // Accept the suggestion at the current cursor position.
            editor?.chain().focus().insertContent(suggestionRef.current).run();
            setSuggestion('');
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
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'NotesEditor.tsx:useEffect-dispatch',
        message: 'useEffect for dispatch triggered',
        data: {
          hasEditor: !!editor,
          suggestionRefCurrent: suggestionRef.current,
          suggestionState: suggestion,
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'C',
      }),
    }).catch(() => {});
    // #endregion
    if (!editor) return;
    if (!suggestionRef.current) return;
    try {
      // #region agent log
      fetch(
        'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'NotesEditor.tsx:dispatch',
            message: 'Dispatching transaction',
            data: { suggestionRefCurrent: suggestionRef.current },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'C',
          }),
        }
      ).catch(() => {});
      // #endregion
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
      setSuggestion('');
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
    // #region agent log
    const audioTrack = stream.getAudioTracks()[0];
    fetch('http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'NotesEditor.tsx:stream-acquired',
        message: 'Audio stream acquired',
        data: {
          streamActive: stream.active,
          trackCount: stream.getAudioTracks().length,
          trackEnabled: audioTrack?.enabled,
          trackMuted: audioTrack?.muted,
          trackLabel: audioTrack?.label,
          trackReadyState: audioTrack?.readyState,
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H',
      }),
    }).catch(() => {});
    // #endregion

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

    const socket = new WebSocket(
      // Parameters tuned for MediaRecorder (auto-detect format)
      'wss://api.deepgram.com/v1/listen?punctuate=true&smart_format=true',
      ['token', DEEPGRAM_API_KEY]
    );
    deepgramSocketRef.current = socket;

    socket.onerror = () => {
      setRecordingError(
        'Deepgram connection error. Check your API key and network.'
      );
      stopRecording();
    };

    socket.onclose = (ev) => {
      // If we didn't explicitly stop, surface a reason.
      if (isRecording) {
        const msg =
          ev.code === 1000
            ? 'Deepgram connection closed.'
            : `Deepgram connection closed (code ${ev.code}).`;
        setRecordingError(msg);
        stopRecording();
      }
    };

    socket.onopen = () => {
      setIsConnecting(false);
      setIsRecording(true);
      setTranscript('');
      setSuggestion('');

      let mediaRecorder: MediaRecorder;
      try {
        // Prefer webm if available; Safari may throw here, so fall back.
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      } catch {
        mediaRecorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = mediaRecorder;
      // #region agent log
      fetch(
        'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'NotesEditor.tsx:mediaRecorder-setup',
            message: 'MediaRecorder created',
            data: {
              mimeType: mediaRecorder.mimeType,
              state: mediaRecorder.state,
              streamActive: stream.active,
              audioTracks: stream.getAudioTracks().length,
            },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'F',
          }),
        }
      ).catch(() => {});
      // #endregion

      mediaRecorder.ondataavailable = (event) => {
        // #region agent log
        fetch(
          'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'NotesEditor.tsx:ondataavailable',
              message: 'Audio chunk',
              data: {
                dataSize: event.data.size,
                dataType: event.data.type,
                socketReady: socket.readyState === WebSocket.OPEN,
              },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'F',
            }),
          }
        ).catch(() => {});
        // #endregion
        try {
          if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
            socket.send(event.data);
          }
        } catch {
          // ignore
        }
      };
      mediaRecorder.start(250); // Send data in 250ms chunks

      // receive transcription results
      socket.onmessage = (message) => {
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
            'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:onmessage-raw',
                message: 'Raw Deepgram data',
                data: {
                  hasChannel: !!data.channel,
                  channelKeys: data.channel ? Object.keys(data.channel) : [],
                  alternatives: data.channel?.alternatives,
                  firstAlt: data.channel?.alternatives?.[0],
                  rawDataKeys: Object.keys(data),
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'A2',
              }),
            }
          ).catch(() => {});
          // #endregion
          const transcriptText = String(
            data.channel?.alternatives?.[0]?.transcript ?? ''
          ).trim();
          // #region agent log
          fetch(
            'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'NotesEditor.tsx:onmessage',
                message: 'Deepgram transcript received',
                data: { transcriptText, isEmpty: !transcriptText },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'A',
              }),
            }
          ).catch(() => {});
          // #endregion
          if (!transcriptText) return;

          setTranscript((prev) => {
            const next = prev ? `${prev} ${transcriptText}` : transcriptText;
            // #region agent log
            fetch(
              'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  location: 'NotesEditor.tsx:setTranscript',
                  message: 'setTranscript callback',
                  data: { modeRefCurrent: modeRef.current, next },
                  timestamp: Date.now(),
                  sessionId: 'debug-session',
                  hypothesisId: 'B',
                }),
              }
            ).catch(() => {});
            // #endregion
            if (modeRef.current === 'autocomplete') {
              // Match old behavior where transcript showed up immediately while recording
              // by ensuring the editor is focused (without inserting into the doc).
              try {
                editor?.chain().focus().run();
              } catch {
                // ignore
              }
              // #region agent log
              fetch(
                'http://127.0.0.1:7243/ingest/3241d929-b830-4c0a-9e58-e7586b9615dc',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    location: 'NotesEditor.tsx:setSuggestion',
                    message: 'Calling setSuggestion',
                    data: { next },
                    timestamp: Date.now(),
                    sessionId: 'debug-session',
                    hypothesisId: 'B',
                  }),
                }
              ).catch(() => {});
              // #endregion
              setSuggestion(next);
            }
            return next;
          });
        } catch (e) {
          console.error('Deepgram message parse failed', e);
        }
      };
    };
  };

  const stopRecording = () => {
    setIsConnecting(false);
    setIsRecording(false);
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

    console.log('Recording stopped...');
  };

  const canFormat = useMemo(() => !!editor, [editor]);
  const canSubmitLink = useMemo(
    () => linkText.trim().length > 0 && linkUrl.trim().length > 0,
    [linkText, linkUrl]
  );
  const fmtClass = (active: boolean) =>
    `format-button${active ? ' active' : ''}`;

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
      <div className='editor-toolbar'>
        <div className='toolbar-group' aria-label='Markdown formatting'>
          <button
            className={fmtClass(!!editor?.isActive('bold'))}
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
            onClick={() => editor?.chain().focus().toggleCode().run()}
            title='Inline code'
            type='button'
            aria-label='Inline code'
            disabled={!canFormat}
          >
            <IconCode />
          </button>
          <button
            className={fmtClass(!!editor?.isActive('codeBlock'))}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            title='Code block'
            type='button'
            aria-label='Code block'
            disabled={!canFormat}
          >
            <IconCodeBlock />
          </button>
          <button
            className={fmtClass(!!editor?.isActive('blockquote'))}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            title='Blockquote'
            type='button'
            aria-label='Blockquote'
            disabled={!canFormat}
          >
            <IconQuote />
          </button>
          <button
            className={fmtClass(!!editor?.isActive('bulletList'))}
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
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            title='Numbered list'
            type='button'
            aria-label='Numbered list'
            disabled={!canFormat}
          >
            1.
          </button>
          <button
            className={fmtClass(!!editor?.isActive('link'))}
            onClick={openLinkModal}
            title='Link'
            type='button'
            aria-label='Insert link'
            disabled={!canFormat}
          >
            <IconLink />
          </button>
          <button
            className={fmtClass(false)}
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

        <div
          className='toolbar-separator'
          role='separator'
          aria-orientation='vertical'
        />

        <div className='toolbar-group' aria-label='Headings'>
          <button
            className={fmtClass(!!editor?.isActive('heading', { level: 1 }))}
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
        </div>

        <div
          className='toolbar-separator'
          role='separator'
          aria-orientation='vertical'
        />

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

        <div
          className='toolbar-separator'
          role='separator'
          aria-orientation='vertical'
        />

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
      {recordingError ? (
        <div className='suggestion-bar' role='status' aria-live='polite'>
          {recordingError}
        </div>
      ) : isRecording && mode === 'suggestion' && transcript.trim() ? (
        <div className='suggestion-bar' role='status' aria-live='polite'>
          Live transcript: “{transcript.slice(-240)}”
        </div>
      ) : null}
      <div className='editor-content' ref={editorScrollRef}>
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

        <button
          type='button'
          className='note-feedback-fab'
          onClick={() => void fetchNoteFeedback()}
          disabled={!canFormat || isLoadingFeedback}
          title='Get feedback on this note'
          aria-label='Get feedback on this note'
        >
          {isLoadingFeedback ? 'Checking…' : 'Note feedback'}
        </button>

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
