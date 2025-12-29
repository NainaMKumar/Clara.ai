import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import './NotesEditor.css'

import type { Note } from '../types'

type NotesEditorProps = {
  note: Note
  onUpdate: (fields: Partial<Note>) => void
}

function IconLink() {
  return (
    <svg className="format-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.59 13.41a1.98 1.98 0 0 0 2.82 0l3.54-3.54a2 2 0 1 0-2.83-2.83l-1.06 1.06a1 1 0 1 1-1.41-1.41l1.06-1.06a4 4 0 1 1 5.66 5.66l-3.54 3.54a3.98 3.98 0 0 1-5.64 0a1 1 0 0 1 1.41-1.41ZM13.41 10.59a1.98 1.98 0 0 0-2.82 0L7.05 14.12a2 2 0 1 0 2.83 2.83l1.06-1.06a1 1 0 1 1 1.41 1.41l-1.06 1.06a4 4 0 1 1-5.66-5.66l3.54-3.54a3.98 3.98 0 0 1 5.64 0a1 1 0 0 1-1.41 1.41Z"
      />
    </svg>
  )
}

function IconImage() {
  return (
    <svg className="format-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21 5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5Zm-2 0v9.17l-2.59-2.58a2 2 0 0 0-2.82 0L7 18.17V5h12ZM5 19v-1.17l7-7l7 7V19H5Zm4.5-9A1.5 1.5 0 1 0 8 8.5A1.5 1.5 0 0 0 9.5 10Z"
      />
    </svg>
  )
}

function IconCode() {
  return (
    <svg className="format-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8.7 16.3a1 1 0 0 1 0 1.4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 1 1 1.4 1.4L5.41 12l3.3 3.3Zm6.6 0L18.59 12l-3.3-3.3a1 1 0 1 1 1.4-1.4l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4 0a1 1 0 0 1 0-1.4ZM10.7 19.6a1 1 0 0 1-.9-1.4l4-14a1 1 0 0 1 1.92.55l-4 14a1 1 0 0 1-1.02.85Z"
      />
    </svg>
  )
}

function IconCodeBlock() {
  return (
    <svg className="format-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Zm1 2.5L18.5 8H15a1 1 0 0 1-1-1V4.5ZM7 20V4h6v3a3 3 0 0 0 3 3h3v10H7Z"
      />
      <path
        fill="currentColor"
        d="M9.2 15.8a1 1 0 0 1 0-1.4L10.6 13l-1.4-1.4a1 1 0 1 1 1.4-1.4l2.1 2.1a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0Zm5.6 0-2.1-2.1a1 1 0 0 1 0-1.4l2.1-2.1a1 1 0 1 1 1.4 1.4L14.8 13l1.4 1.4a1 1 0 1 1-1.4 1.4Z"
      />
    </svg>
  )
}

function IconQuote() {
  return (
    <svg className="format-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7.17 6.17A4 4 0 0 0 5 9.76V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H7.02c.05-1.52.68-2.82 2.15-3.7a1 1 0 1 0-1-1.73Zm10 0A4 4 0 0 0 15 9.76V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-1.98c.05-1.52.68-2.82 2.15-3.7a1 1 0 1 0-1-1.73Z"
      />
    </svg>
  )
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toEditorHtml(content: string) {
  // If it already looks like HTML, keep it; otherwise treat it as plain text.
  const trimmed = content.trim()
  if (trimmed.startsWith('<')) return content
  if (!trimmed) return '<p></p>'
  return `<p>${escapeHtml(content).replace(/\n/g, '<br />')}</p>`
}

const NotesEditor: React.FC<NotesEditorProps> = ({ note, onUpdate }) => {
  const [title, setTitle] = useState(note.title)
  const [isRecording, setIsRecording] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [deepgramSocket, setDeepgramSocket] = useState<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const [mode, setMode] = useState<'autocomplete' | 'suggestion'>('suggestion')
  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false)
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkUrl, setLinkUrl] = useState('https://')
  const [linkSelection, setLinkSelection] = useState<{ from: number; to: number; empty: boolean } | null>(null)
  const [isImageModalOpen, setIsImageModalOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [imageSelection, setImageSelection] = useState<{ from: number; to: number } | null>(null)

  const insertImageAtSelection = async (opts: { src: string }) => {
    if (!editor) return
    const sel = imageSelection ?? { from: editor.state.selection.from, to: editor.state.selection.to }
    editor.chain().focus().setTextSelection(sel).setImage({ src: opts.src }).run()
  }

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })

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
      ],
      content: toEditorHtml(note.content),
      editorProps: {
        attributes: {
          class: 'wysiwyg-editor',
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Tab' && suggestion.trim()) {
            event.preventDefault()
            // Accept the suggestion at the current cursor position.
            editor?.chain().focus().insertContent(suggestion).run()
            setSuggestion('')
            return true
          }
          if (event.key === 'Escape' && isLinkModalOpen) {
            event.preventDefault()
            setIsLinkModalOpen(false)
            return true
          }
          if (event.key === 'Escape' && isImageModalOpen) {
            event.preventDefault()
            setIsImageModalOpen(false)
            return true
          }
          return false
        },
        handlePaste: (_view, event) => {
          // Allow direct image pasting into the editor: insert image at cursor.
          const clipboard = event.clipboardData
          if (!clipboard) return false

          const items = Array.from(clipboard.items)
          const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))
          if (!imageItem) return false

          const file = imageItem.getAsFile()
          if (!file) return false

          event.preventDefault()
          ;(async () => {
            try {
              const src = await readFileAsDataUrl(file)
              // Use current selection in editor (no modal needed for paste).
              editor?.chain().focus().setImage({ src }).run()
            } catch (err) {
              console.error('Failed to paste image', err)
            }
          })()
          return true
        },
      },
      onUpdate: ({ editor }) => {
        const html = editor.getHTML()
        onUpdate({ content: html })
        if (suggestion) setSuggestion('')
      },
    },
    // Recreate editor when switching notes (simplest + avoids content desync).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id]
  )

  // Force re-render on selection/transaction changes so toolbar toggles reflect stored marks
  // even when the document doesn't change (e.g., bold toggled on an empty editor).
  const [, forceToolbarUpdate] = useState(0)
  useEffect(() => {
    if (!editor) return
    const bump = () => forceToolbarUpdate((n) => (n + 1) % 1_000_000)
    editor.on('transaction', bump)
    editor.on('selectionUpdate', bump)
    return () => {
      editor.off('transaction', bump)
      editor.off('selectionUpdate', bump)
    }
  }, [editor])

  // Keep local state in sync when switching notes.
  useEffect(() => {
    setTitle(note.title)
    setTranscript('')
      setSuggestion('')
    // If you switch notes mid-recording, stop cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  const handleRecordingToggle = () => {
    if (isRecording) {
      // Stop recording
      stopRecording()
    } else {
      // Start recording
      startRecording()
    }
  }

  const fetchAISuggestion = async(typedText: string, spokenTranscript: string) =>  {
    const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content: 'You help complete text. The user spoke a sentence and typed part of it. Output ONLY the remaining words they spoke but haven\'t typed yet. Do not repeat what they already typed. Do not rephrase. Extract only the untyped portion.'
              },
              {
                role: 'user',
                content: `What was recorded: "${spokenTranscript}"\n What the user typed: "${typedText}"\n\nOnly output the remaining words:`
              }
            ],
            max_tokens: 100,
            temperature: 0.2
          })
        })

        const data = await response.json()
        return data.choices[0].message.content
  }

  // Debounced AI suggestion while typing (only in "suggestion" mode).
  useEffect(() => {
    if (mode !== 'suggestion') return
    if (!transcript.trim()) return

    setSuggestion('')
    const timer = window.setTimeout(async () => {
      const typedText = editor?.getText() ?? ''
      const context = `${typedText}${transcript ? ` ${transcript}` : ''}`
      if (context.trim().length <= 10) return

        setIsLoadingSuggestion(true)
        try {
        const aiSuggestion = await fetchAISuggestion(typedText, context)
          setSuggestion(aiSuggestion)
          setTranscript('')
        } catch (error) {
        console.error('Failed to fetch AI suggestion', error)
        } finally {
          setIsLoadingSuggestion(false)
      }
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [editor, transcript, mode])

  const startRecording = async () => {
    const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY || ''
    const socket = new WebSocket('wss://api.deepgram.com/v1/listen', ['token', DEEPGRAM_API_KEY])

    socket.onopen = async () => {
      setIsRecording(true)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })

      mediaStreamRef.current = stream
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data)
        }
      }
      mediaRecorder.start(250) // Send data in 250ms chunks

      // receive transcription results
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data)
        const transcriptText = data.channel?.alternatives?.[0]?.transcript
        if (transcriptText) {
          setTranscript(prev => prev + ' ' + transcriptText)
          if (mode == 'autocomplete') {
            editor?.chain().focus().insertContent(`${transcriptText} `).run()
            setSuggestion('')
          } else {
            setSuggestion(prev => prev + ' ' + transcriptText)
          }
          
        }
      }
      setDeepgramSocket(socket)
    }

  }

  const stopRecording = () => {
    setIsRecording(false)
    if (mediaRecorderRef) {
      mediaRecorderRef.current?.stop()
      mediaRecorderRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop())
      mediaStreamRef.current = null
    }

    // close the Deepgram websocket
    if (deepgramSocket) {
      deepgramSocket.close()
      setDeepgramSocket(null)
    }

    setTranscript('')
    setSuggestion('')

    console.log('Recording stopped...')
    
  }

  const canFormat = useMemo(() => !!editor, [editor])
  const canSubmitLink = useMemo(() => linkText.trim().length > 0 && linkUrl.trim().length > 0, [linkText, linkUrl])
  const fmtClass = (active: boolean) => `format-button${active ? ' active' : ''}`

  const openLinkModal = () => {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    setLinkSelection({ from, to, empty })

    if (empty) {
      setLinkText('')
      setLinkUrl('https://')
    } else {
      const selected = editor.state.doc.textBetween(from, to, ' ')
      const previousUrl = editor.getAttributes('link').href as string | undefined
      setLinkText(selected)
      setLinkUrl(previousUrl ?? 'https://')
    }

    setIsLinkModalOpen(true)
  }

  const submitLink = () => {
    if (!editor) return
    if (!linkSelection) return
    const href = linkUrl.trim()
    const text = linkText.trim()
    if (!href || !text) return

    const { from, to, empty } = linkSelection
    editor.chain().focus().setTextSelection({ from, to }).run()

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
        .run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    }

    setIsLinkModalOpen(false)
  }

  const openImageModal = () => {
    if (!editor) return
    const { from, to } = editor.state.selection
    setImageSelection({ from, to })
    setImageUrl('')
    setIsImageModalOpen(true)
  }

  const submitImageUrl = async () => {
    const src = imageUrl.trim()
    if (!src) return
    await insertImageAtSelection({ src })
    setIsImageModalOpen(false)
  }

  return (
    <div className="notes-editor">
      <div className="editor-header">
        <input
          type="text"
          value={title}
          onChange={(e) => {
            const next = e.target.value
            setTitle(next)
            onUpdate({ title: next })
          }}
          className="note-title-input"
          placeholder="Note Title"
        />
      </div>
      <div className="editor-toolbar">
        <div className="toolbar-group" aria-label="Markdown formatting">
          <button
            className={fmtClass(!!editor?.isActive('bold'))}
            onClick={() => editor?.chain().focus().toggleBold().run()}
            title="Bold"
            type="button"
            aria-label="Bold"
            disabled={!canFormat}
          >
            B
          </button>
          <button
            className={fmtClass(!!editor?.isActive('italic'))}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            title="Italic"
            type="button"
            aria-label="Italic"
            disabled={!canFormat}
          >
            I
          </button>
          <button
            className={fmtClass(!!editor?.isActive('strike'))}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            title="Strikethrough"
            type="button"
            aria-label="Strikethrough"
            disabled={!canFormat}
          >
            S
          </button>
          <button
            className={fmtClass(!!editor?.isActive('code'))}
            onClick={() => editor?.chain().focus().toggleCode().run()}
            title="Inline code"
            type="button"
            aria-label="Inline code"
            disabled={!canFormat}
          >
            <IconCode />
          </button>
          <button
            className={fmtClass(!!editor?.isActive('codeBlock'))}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            title="Code block"
            type="button"
            aria-label="Code block"
            disabled={!canFormat}
          >
            <IconCodeBlock />
          </button>
          <button
            className={fmtClass(!!editor?.isActive('blockquote'))}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            title="Blockquote"
            type="button"
            aria-label="Blockquote"
            disabled={!canFormat}
          >
            <IconQuote />
          </button>
          <button
            className={fmtClass(!!editor?.isActive('bulletList'))}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            title="Bullet list"
            type="button"
            aria-label="Bullet list"
            disabled={!canFormat}
          >
            •
          </button>
          <button
            className={fmtClass(!!editor?.isActive('orderedList'))}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            title="Numbered list"
            type="button"
            aria-label="Numbered list"
            disabled={!canFormat}
          >
            1.
          </button>
          <button
            className={fmtClass(!!editor?.isActive('link'))}
            onClick={openLinkModal}
            title="Link"
            type="button"
            aria-label="Insert link"
            disabled={!canFormat}
          >
            <IconLink />
          </button>
          <button
            className={fmtClass(false)}
            onClick={() => {
              openImageModal()
            }}
            title="Image"
            type="button"
            aria-label="Insert image"
            disabled={!canFormat}
          >
            <IconImage />
          </button>
        </div>

        <div className="toolbar-separator" role="separator" aria-orientation="vertical" />

        <div className="toolbar-group" aria-label="Headings">
          <button
            className={fmtClass(!!editor?.isActive('heading', { level: 1 }))}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            title="Heading 1"
            type="button"
            aria-label="Heading 1"
            disabled={!canFormat}
          >
            H1
          </button>
          <button
            className={fmtClass(!!editor?.isActive('heading', { level: 2 }))}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Heading 2"
            type="button"
            aria-label="Heading 2"
            disabled={!canFormat}
          >
            H2
          </button>
          <button
            className={fmtClass(!!editor?.isActive('heading', { level: 3 }))}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
            title="Heading 3"
            type="button"
            aria-label="Heading 3"
            disabled={!canFormat}
          >
            H3
          </button>
        </div>

        <div className="toolbar-separator" role="separator" aria-orientation="vertical" />

        <div className="toolbar-group" aria-label="AI modes">
        <button 
          className={`mode-button ${mode === 'autocomplete' ? 'active' : ''}`}
          onClick={() => setMode('autocomplete')}
          title="Autocomplete mode"
            type="button"
        >
          Autocomplete
        </button>

        <button 
          className={`mode-button ${mode === 'suggestion' ? 'active': ''}`}
          onClick={() => setMode('suggestion')}
          title="suggestion mode"
            type="button"
        >
          Suggestion
        </button>
        </div>

        <div className="toolbar-separator" role="separator" aria-orientation="vertical" />

        <div className="toolbar-group" aria-label="Recording">
        <button
          className={`record-button ${isRecording ? 'recording' : ''}`}
          onClick={handleRecordingToggle}
          title={isRecording ? 'Stop Recording' : 'Start Recording'}
            type="button"
        >
          <span className="record-icon"></span>
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>
        </div>
      </div>
      <div className="editor-content">
        <div className="wysiwyg-editor-container">
          <EditorContent editor={editor} />
        </div>

        {isLinkModalOpen ? (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Insert link"
            onMouseDown={() => setIsLinkModalOpen(false)}
          >
            <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-title">Insert link</div>

              <label className="modal-label">
                Text
                <input
                  className="modal-input"
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                  placeholder="Link text"
                  autoFocus
                />
              </label>

              <label className="modal-label">
                URL
                <input
                  className="modal-input"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://example.com"
                />
              </label>

              <div className="modal-actions">
                <button
                  className="modal-button secondary"
                  type="button"
                  onClick={() => setIsLinkModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="modal-button primary"
                  type="button"
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
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Insert image"
            onMouseDown={() => setIsImageModalOpen(false)}
          >
            <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-title">Insert image</div>

              <label className="modal-label">
                Upload
                <input
                  className="modal-input"
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    try {
                      const src = await readFileAsDataUrl(file)
                      await insertImageAtSelection({ src })
                      setIsImageModalOpen(false)
                    } catch (err) {
                      console.error('Failed to upload image', err)
                    }
                  }}
                />
              </label>

              <label className="modal-label">
                Or paste / enter URL
                <input
                  className="modal-input"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://example.com/image.png"
                  onPaste={(e) => {
                    const items = Array.from(e.clipboardData.items)
                    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))
                    if (!imageItem) return
                    const file = imageItem.getAsFile()
                    if (!file) return

                    e.preventDefault()
                    ;(async () => {
                      try {
                        const src = await readFileAsDataUrl(file)
                        await insertImageAtSelection({ src })
                        setIsImageModalOpen(false)
                      } catch (err) {
                        console.error('Failed to paste image into modal', err)
                      }
                    })()
                  }}
                />
              </label>

              <div className="modal-actions">
                <button
                  className="modal-button secondary"
                  type="button"
                  onClick={() => setIsImageModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="modal-button primary"
                  type="button"
                  onClick={submitImageUrl}
                  disabled={!imageUrl.trim()}
                >
                  Insert
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {(isLoadingSuggestion || suggestion.trim()) && mode === 'suggestion' ? (
          <div className="suggestion-bar" role="status" aria-live="polite">
            {isLoadingSuggestion ? (
              <span className="suggestion-muted">Thinking…</span>
            ) : (
              <>
                <span className="suggestion-muted">Press Tab to accept:</span>
                <span className="suggestion-text-inline">{suggestion}</span>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default NotesEditor