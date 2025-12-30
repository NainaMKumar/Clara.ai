import React, { useEffect, useRef, useState } from 'react'
import Sidebar from '../components/Sidebar'
import NotesEditor from '../components/NotesEditor'
import { Note, Folder } from '../types'
import './NotesPage.css'
import * as rag from '../rag/rag'
import type { ChatMessage } from '../rag/rag'

type ConversationMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: Array<{ chunkId: string; noteId: string; quote: string }>
  timestamp: number
}

const NotesPage: React.FC = () => {
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const raw = localStorage.getItem('clara_notes_v1')
      if (raw) return JSON.parse(raw) as Note[]
    } catch {
      // ignore
    }
    return [
      {
        id: '1',
        title: 'Welcome to Clara',
        content: '',
        date: new Date().toLocaleDateString(),
      },
    ]
  })

  const [folders, setFolders] = useState<Folder[]>(() => {
    try {
      const raw = localStorage.getItem('clara_folders_v1')
      if (raw) return JSON.parse(raw) as Folder[]
    } catch {
      // ignore
    }
    return []
  })

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>('1')
  const [ragQuestion, setRagQuestion] = useState('')
  const [conversation, setConversation] = useState<ConversationMessage[]>([])
  const [ragError, setRagError] = useState<string>('')
  const [isAsking, setIsAsking] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const [lastIndexMsg, setLastIndexMsg] = useState<string>('')
  const [activeCitation, setActiveCitation] = useState<{ noteId: string; quote: string } | null>(null)
  const [isRagOpen, setIsRagOpen] = useState(true)
  const indexTimersRef = useRef<Record<string, number>>({})
  const isIndexingAllRef = useRef(false)
  const conversationEndRef = useRef<HTMLDivElement>(null)

  const handleNoteSelect = (id: string) => {
    setSelectedNoteId(id)
  }

  // Persist notes locally so RAG (and notes) survive refresh.
  useEffect(() => {
    try {
      localStorage.setItem('clara_notes_v1', JSON.stringify(notes))
    } catch {
      // ignore
    }
  }, [notes])

  // Persist folders
  useEffect(() => {
    try {
      localStorage.setItem('clara_folders_v1', JSON.stringify(folders))
    } catch {
      // ignore
    }
  }, [folders])

  const handleNewNote = (folderId?: string) => {
    const newNote: Note = {
      id: Date.now().toString(),
      title: 'New Note',
      content: '',
      date: new Date().toLocaleDateString(),
      folderId
    }
    setNotes([newNote, ...notes])
    setSelectedNoteId(newNote.id)
    scheduleIndex(newNote)
  }

  const handleNewFolder = () => {
    const newFolder: Folder = {
      id: Date.now().toString(),
      name: 'New Folder',
      createdDate: new Date().toLocaleDateString()
    }
    setFolders([...folders, newFolder])
  }

  const handleDeleteFolder = (id: string) => {
    setFolders(folders.filter(f => f.id !== id))
    // Unassign notes from deleted folder
    setNotes(notes.map(note =>
      note.folderId === id ? { ...note, folderId: undefined } : note
    ))
  }

  const handleRenameFolder = (id: string, name: string) => {
    setFolders(folders.map(f =>
      f.id === id ? { ...f, name } : f
    ))
  }

  const handleMoveNoteToFolder = (noteId: string, folderId?: string) => {
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id !== noteId) return n
        // No-op if already in target folder
        if ((n.folderId ?? undefined) === (folderId ?? undefined)) return n
        return { ...n, folderId }
      })
    )
  }

  const handleNoteUpdate = (id: string, updatedFields: Partial<Note>) => {
    const next = notes.map(note =>
      note.id === id ? { ...note, ...updatedFields, date: new Date().toLocaleDateString() } : note
    )
    setNotes(next)
    const updated = next.find((n) => n.id === id)
    if (updated) scheduleIndex(updated)
  }

  const handleDeleteNote = (id: string) => {
    const newNotes = notes.filter(note => note.id !== id)
    setNotes(newNotes)
    if (selectedNoteId === id) {
      setSelectedNoteId(null)
    }
    void rag.deleteNote(id).catch(() => {
      // ignore
    })
  }

  const selectedNote = notes.find(n => n.id === selectedNoteId)

  const scheduleIndex = (note: Note) => {
    const timers = indexTimersRef.current
    if (timers[note.id]) window.clearTimeout(timers[note.id])
    timers[note.id] = window.setTimeout(async () => {
      setIsIndexing(true)
      setLastIndexMsg('Indexing…')
      try {
        const res = await rag.upsertNote(note)
        setLastIndexMsg(res.indexed ? `Indexed (${res.totalChunks} chunks, embedded ${res.embedded})` : 'Up to date')
      } catch (e) {
        setLastIndexMsg(e instanceof Error ? e.message : 'Indexing failed')
      } finally {
        setIsIndexing(false)
      }
    }, 1500)
  }

  const ensureAllIndexed = async () => {
    if (isIndexingAllRef.current) return
    isIndexingAllRef.current = true
    setIsIndexing(true)
    setLastIndexMsg('Indexing all notes…')
    try {
      let embedded = 0
      let chunks = 0
      for (const n of notes) {
        const res = await rag.upsertNote(n)
        if (res.indexed) {
          embedded += res.embedded
          chunks += res.totalChunks
        }
      }
      setLastIndexMsg(embedded > 0 ? `Indexed (${chunks} chunks, embedded ${embedded})` : 'Up to date')
    } catch (e) {
      setLastIndexMsg(e instanceof Error ? e.message : 'Indexing failed')
    } finally {
      setIsIndexing(false)
      isIndexingAllRef.current = false
    }
  }

  const askClara = async () => {
    const q = ragQuestion.trim()
    if (!q) return
    setIsAsking(true)
    setRagError('')
    
    // Add user message to conversation immediately
    const userMessage: ConversationMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: q,
      timestamp: Date.now(),
    }
    setConversation(prev => [...prev, userMessage])
    setRagQuestion('')
    
    try {
      // Safety net: make sure the full note corpus is indexed before retrieval.
      await ensureAllIndexed()
      
      // Build history from previous messages (excluding the current one we just added)
      const history: ChatMessage[] = conversation.map(msg => ({
        role: msg.role,
        content: msg.content,
      }))
      
      const out = await rag.askWithHistory(q, history)
      
      // Add assistant response to conversation
      const assistantMessage: ConversationMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: out.answer.answer,
        citations: out.answer.citations || [],
        timestamp: Date.now(),
      }
      setConversation(prev => [...prev, assistantMessage])
    } catch (e) {
      setRagError(e instanceof Error ? e.message : 'Failed to ask')
      // Remove the user message if the request failed
      setConversation(prev => prev.filter(msg => msg.id !== userMessage.id))
    } finally {
      setIsAsking(false)
    }
  }

  const clearConversation = () => {
    setConversation([])
    setRagError('')
  }

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation])

  useEffect(() => {
    // Index everything once on load / refresh so the buttons aren’t necessary.
    void ensureAllIndexed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="notes-page">
      <Sidebar
        notes={notes}
        folders={folders}
        onSelectNote={handleNoteSelect}
        onNewNote={handleNewNote}
        onDeleteNote={handleDeleteNote}
        onMoveNote={handleMoveNoteToFolder}
        onNewFolder={handleNewFolder}
        onDeleteFolder={handleDeleteFolder}
        onRenameFolder={handleRenameFolder}
        selectedNoteId={selectedNoteId}
      />
      <div className="notes-main">
        <div className="notes-content">
          <div className="editor-pane">
            {selectedNote ? (
              <>
                {activeCitation && activeCitation.noteId === selectedNote.id ? (
                  <div className="citation-jump" role="status" aria-live="polite">
                    <span className="citation-jump-label">Jumped to citation:</span>
                    <span className="citation-jump-quote">“{activeCitation.quote}”</span>
                    <button type="button" className="citation-jump-clear" onClick={() => setActiveCitation(null)}>
                      Dismiss
                    </button>
                  </div>
                ) : null}
                <NotesEditor note={selectedNote} onUpdate={(fields) => handleNoteUpdate(selectedNote.id, fields)} />
              </>
            ) : (
              <div className="no-note-selected">
                <p>Select a note or create a new one</p>
              </div>
            )}
          </div>

          <aside className={`rag-sidebar ${isRagOpen ? 'open' : 'closed'}`} aria-label="Ask Clara sidebar">
            <button
              type="button"
              className="rag-toggle"
              onClick={() => setIsRagOpen((v) => !v)}
              aria-expanded={isRagOpen}
              aria-label={isRagOpen ? 'Collapse Ask Clara sidebar' : 'Expand Ask Clara sidebar'}
              title={isRagOpen ? 'Collapse' : 'Ask Clara'}
            >
              <span className="sr-only">{isRagOpen ? 'Collapse Ask Clara' : 'Expand Ask Clara'}</span>
              {isRagOpen ? (
                // Collapse icon (chevron right)
                <svg className="rag-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M9.29 6.71a1 1 0 0 1 1.42 0L15 11a1.5 1.5 0 0 1 0 2l-4.29 4.29a1 1 0 1 1-1.42-1.42L13.17 12L9.29 8.12a1 1 0 0 1 0-1.41Z"
                  />
                </svg>
              ) : (
                // Expand icon (chevron left)
                <svg className="rag-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M14.71 6.71a1 1 0 0 0-1.42 0L9 11a1.5 1.5 0 0 0 0 2l4.29 4.29a1 1 0 1 0 1.42-1.42L10.83 12l3.88-3.88a1 1 0 0 0 0-1.41Z"
                  />
                </svg>
              )}
            </button>

            <div className={`rag-sidebar-body ${isRagOpen ? '' : 'hidden'}`}>
              <div className="rag-panel" aria-label="Ask Clara">
                <div className="rag-panel-header">
                  <div className="rag-title">Ask Clara about your notes</div>
                  <div className="rag-header-actions">
                    <div className="rag-status">{isIndexing ? 'Indexing…' : lastIndexMsg}</div>
                    {conversation.length > 0 && (
                      <button
                        type="button"
                        className="rag-button secondary small"
                        onClick={clearConversation}
                        title="Clear conversation"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className="rag-conversation" role="log" aria-label="Conversation with Clara">
                  {conversation.length === 0 && !isAsking ? (
                    <div className="rag-empty-state">
                      <p>Ask Clara anything about your notes. She'll search through them to find relevant information.</p>
                    </div>
                  ) : (
                    conversation.map((msg) => (
                      <div key={msg.id} className={`rag-message rag-message--${msg.role}`}>
                        <div className="rag-message-role">
                          {msg.role === 'user' ? 'You' : 'Clara'}
                        </div>
                        <div className="rag-message-content">{msg.content}</div>
                        {msg.citations && msg.citations.length > 0 && (
                          <div className="rag-citations">
                            <div className="rag-citations-title">Citations</div>
                            <ul>
                              {msg.citations.map((c) => (
                                <li key={`${c.chunkId}:${c.noteId}`}>
                                  <button
                                    type="button"
                                    className="rag-citation-button"
                                    onClick={() => {
                                      setSelectedNoteId(c.noteId)
                                      setActiveCitation({ noteId: c.noteId, quote: c.quote })
                                    }}
                                  >
                                    <span className="rag-citation-note">{notes.find((n) => n.id === c.noteId)?.title || c.noteId}</span>
                                    <span className="rag-citation-quote"> — "{c.quote}"</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                  {isAsking && (
                    <div className="rag-message rag-message--assistant rag-message--loading">
                      <div className="rag-message-role">Clara</div>
                      <div className="rag-message-content">
                        <span className="rag-typing-indicator">
                          <span></span><span></span><span></span>
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={conversationEndRef} />
                </div>

                {ragError ? <div className="rag-error">{ragError}</div> : null}

                <div className="rag-input-row">
                  <input
                    className="rag-input"
                    placeholder={conversation.length > 0 ? "Ask a follow-up question…" : "Ask a question…"}
                    value={ragQuestion}
                    onChange={(e) => setRagQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void askClara()
                      }
                    }}
                    disabled={isAsking}
                  />
                  <button type="button" className="rag-button primary" onClick={() => void askClara()} disabled={isAsking || isIndexing || !ragQuestion.trim()}>
                    {isAsking ? 'Asking…' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

export default NotesPage
