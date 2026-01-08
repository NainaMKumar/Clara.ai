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
  
  // Sidebar state
  const [isSidebarPinned, setIsSidebarPinned] = useState(() => {
    try {
      const raw = localStorage.getItem('clara_sidebar_pinned')
      return raw === 'true'
    } catch {
      return true // Default to pinned
    }
  })
  const [isSidebarHovered, setIsSidebarHovered] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const sidebarHideTimeoutRef = useRef<number | null>(null)
  
  const indexTimersRef = useRef<Record<string, number>>({})
  const isIndexingAllRef = useRef(false)
  const conversationEndRef = useRef<HTMLDivElement>(null)

  // Persist sidebar pinned state
  useEffect(() => {
    try {
      localStorage.setItem('clara_sidebar_pinned', String(isSidebarPinned))
    } catch {
      // ignore
    }
  }, [isSidebarPinned])

  const handleSidebarMouseEnter = () => {
    if (sidebarHideTimeoutRef.current) {
      window.clearTimeout(sidebarHideTimeoutRef.current)
      sidebarHideTimeoutRef.current = null
    }
    setIsSidebarHovered(true)
  }

  const handleSidebarMouseLeave = () => {
    // Small delay before hiding to prevent flicker
    sidebarHideTimeoutRef.current = window.setTimeout(() => {
      setIsSidebarHovered(false)
    }, 300)
  }

  const handleHoverZoneEnter = () => {
    if (sidebarHideTimeoutRef.current) {
      window.clearTimeout(sidebarHideTimeoutRef.current)
      sidebarHideTimeoutRef.current = null
    }
    setIsSidebarHovered(true)
  }

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
      console.error('RAG Error:', e);
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
    // Index everything once on load / refresh so the buttons aren't necessary.
    void ensureAllIndexed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isSidebarVisible = isSidebarPinned || isSidebarHovered

  return (
    <div className="notes-page">
      {/* Hover zone for showing sidebar when not pinned */}
      {!isSidebarPinned && (
        <div 
          className="sidebar-hover-zone"
          onMouseEnter={handleHoverZoneEnter}
        />
      )}
      
      <div
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
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
          isVisible={isSidebarVisible}
          isPinned={isSidebarPinned}
          onTogglePin={() => setIsSidebarPinned(p => !p)}
          onWidthChange={setSidebarWidth}
        />
      </div>
      
      <div 
        className={`notes-main ${isSidebarPinned ? 'sidebar-pinned' : 'sidebar-unpinned'}`}
        style={isSidebarPinned ? { marginLeft: sidebarWidth } : undefined}
      >
        <div className="notes-content">
          <div className="editor-pane">
            {selectedNote ? (
              <>
                {activeCitation && activeCitation.noteId === selectedNote.id ? (
                  <div className="citation-jump" role="status" aria-live="polite">
                    <span className="citation-jump-label">Jumped to citation:</span>
                    <span className="citation-jump-quote">"{activeCitation.quote}"</span>
                    <button type="button" className="citation-jump-clear" onClick={() => setActiveCitation(null)}>
                      Dismiss
                    </button>
                  </div>
                ) : null}
                <NotesEditor note={selectedNote} onUpdate={(fields) => handleNoteUpdate(selectedNote.id, fields)} isRagSidebarOpen={isRagOpen} />
              </>
            ) : (
              <div className="no-note-selected">
                <p>Select a note or create a new one</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Floating buttons */}
      <div className={`floating-buttons ${isRagOpen ? 'rag-open' : ''}`}>
        <button
          type="button"
          className="ask-clara-button"
          onClick={() => setIsRagOpen(prev => !prev)}
          aria-label="Ask Clara"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM13 19H11V17H13V19ZM15.07 11.25L14.17 12.17C13.45 12.9 13 13.5 13 15H11V14.5C11 13.4 11.45 12.4 12.17 11.67L13.41 10.41C13.78 10.05 14 9.55 14 9C14 7.9 13.1 7 12 7C10.9 7 10 7.9 10 9H8C8 6.79 9.79 5 12 5C14.21 5 16 6.79 16 9C16 9.88 15.64 10.68 15.07 11.25Z"
              fill="currentColor"
            />
          </svg>
          <span>{isRagOpen ? 'Close Clara' : 'Ask Clara'}</span>
        </button>
        <button
          type="button"
          className="note-feedback-button"
          onClick={() => {
            // Trigger note feedback - dispatch custom event for NotesEditor to handle
            window.dispatchEvent(new CustomEvent('clara:request-feedback'))
          }}
          disabled={!selectedNote}
          aria-label="Note Feedback"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM20 16H5.17L4 17.17V4H20V16ZM11 5H13V11H11V5ZM11 13H13V15H11V13Z"
              fill="currentColor"
            />
          </svg>
          <span>Note Feedback</span>
        </button>
      </div>

      {/* Ask Clara sidebar */}
      <aside className={`rag-sidebar ${isRagOpen ? 'open' : 'closed'}`} aria-label="Ask Clara sidebar">
          <div className="rag-sidebar-header">
            <div className="rag-title">Ask Clara</div>
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
              <button
                type="button"
                className="rag-sidebar-close"
                onClick={() => setIsRagOpen(false)}
                aria-label="Close sidebar"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
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
        </aside>
    </div>
  )
}

export default NotesPage
