import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Note, Folder } from '../types'
import './Sidebar.css'

function stripHtml(html: string) {
  // Quick client-side strip for previews (keeps this dependency-free).
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim()
}

interface SidebarProps {
  notes: Note[]
  folders: Folder[]
  onSelectNote: (id: string) => void
  onNewNote: (folderId?: string) => void
  onDeleteNote: (id: string) => void
  onMoveNote: (noteId: string, folderId?: string) => void
  onNewFolder: () => void
  onDeleteFolder: (id: string) => void
  onRenameFolder: (id: string, name: string) => void
  selectedNoteId: string | null
  isVisible: boolean
  isPinned: boolean
  onTogglePin: () => void
  onWidthChange?: (width: number) => void
}

const NOTE_DRAG_MIME = 'application/x-clara-note-id'

const MIN_WIDTH = 200
const MAX_WIDTH = 500
const DEFAULT_WIDTH = 280

const Sidebar: React.FC<SidebarProps> = ({
  notes,
  folders,
  onSelectNote,
  onNewNote,
  onDeleteNote,
  onMoveNote,
  onNewFolder,
  onDeleteFolder,
  onRenameFolder,
  selectedNoteId,
  isVisible,
  isPinned,
  onTogglePin,
  onWidthChange
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(folders.map(f => f.id))
  )
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null)
  const [dropOverFolderId, setDropOverFolderId] = useState<string | null>(null)
  const [isDropOverUnfiled, setIsDropOverUnfiled] = useState(false)
  
  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('clara_sidebar_width')
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          return parsed
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_WIDTH
  })
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Persist sidebar width and notify parent
  useEffect(() => {
    try {
      localStorage.setItem('clara_sidebar_width', String(sidebarWidth))
    } catch {
      // ignore
    }
    onWidthChange?.(sidebarWidth)
  }, [sidebarWidth, onWidthChange])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = e.clientX
      setSidebarWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth)))
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  const toggleFolder = (id: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const startEditingFolder = (folder: Folder) => {
    setEditingFolderId(folder.id)
    setEditingFolderName(folder.name)
  }

  const finishEditingFolder = () => {
    if (editingFolderId && editingFolderName.trim()) {
      onRenameFolder(editingFolderId, editingFolderName.trim())
    }
    setEditingFolderId(null)
    setEditingFolderName('')
  }

  const getDraggedNoteId = (dt: DataTransfer | null): string | null => {
    if (!dt) return null
    const fromCustom = dt.getData(NOTE_DRAG_MIME)
    if (fromCustom) return String(fromCustom)
    const fromText = dt.getData('text/plain')
    return fromText ? String(fromText) : null
  }

  const requestDrop = (e: React.DragEvent) => {
    // Required so the browser allows dropping.
    e.preventDefault()
    try {
      e.dataTransfer.dropEffect = 'move'
    } catch {
      // ignore
    }
  }

  const sidebarClasses = [
    'sidebar',
    isVisible || isPinned ? 'visible' : 'collapsed',
    isPinned ? 'pinned' : ''
  ].filter(Boolean).join(' ')

  const renderNote = (note: Note) => (
    <div
      key={note.id}
      className={`note-item ${selectedNoteId === note.id ? 'active' : ''} ${draggingNoteId === note.id ? 'dragging' : ''}`}
      onClick={() => onSelectNote(note.id)}
      draggable
      onDragStart={(e) => {
        setDraggingNoteId(note.id)
        try {
          e.dataTransfer.setData(NOTE_DRAG_MIME, note.id)
          e.dataTransfer.setData('text/plain', note.id)
          e.dataTransfer.effectAllowed = 'move'
        } catch {
          // ignore
        }
      }}
      onDragEnd={() => {
        setDraggingNoteId(null)
        setDropOverFolderId(null)
        setIsDropOverUnfiled(false)
      }}
    >
      <h3>{note.title || 'Untitled Note'}</h3>
      <p>
        {(() => {
          const preview = stripHtml(note.content || '')
          const truncated = preview.substring(0, 50)
          return `${truncated || 'No additional text'}${preview.length > 50 ? '...' : ''}`
        })()}
      </p>
      <span className="note-date">{note.date}</span>
      <button
        className="note-delete-btn"
        onClick={(e) => {
          e.stopPropagation()
          onDeleteNote(note.id)
        }}
        title="Delete Note"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
      </button>
    </div>
  )

  const unfiledNotes = notes.filter(note => !note.folderId)

  return (
    <div 
      className={sidebarClasses}
      ref={sidebarRef}
      style={{ width: isVisible || isPinned ? sidebarWidth : undefined }}
    >
      <div className="sidebar-header">
        <div className="sidebar-header-top">
          <h2>My Notes</h2>
          <button
            className={`sidebar-pin-btn ${isPinned ? 'pinned' : ''}`}
            onClick={onTogglePin}
            title={isPinned ? 'Unpin sidebar' : 'Pin sidebar'}
          >
            {isPinned ? (
              // Pinned icon (pin filled)
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z"></path>
              </svg>
            ) : (
              // Unpinned icon (pin outline)
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z"></path>
              </svg>
            )}
          </button>
        </div>
        <div className="sidebar-header-actions">
          <button className="new-folder-btn" onClick={onNewFolder} title="New Folder">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              <line x1="12" y1="11" x2="12" y2="17"></line>
              <line x1="9" y1="14" x2="15" y2="14"></line>
            </svg>
          </button>
          <button className="new-note-btn" onClick={() => onNewNote()} title="New Note">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
      </div>

      <div className="notes-list">
        {/* Folders */}
        {folders.map(folder => {
          const folderNotes = notes.filter(note => note.folderId === folder.id)
          const isExpanded = expandedFolders.has(folder.id)
          const isEditing = editingFolderId === folder.id
          const isDropOver = dropOverFolderId === folder.id

          return (
            <div key={folder.id} className="folder-section">
              <div
                className={`folder-header ${isDropOver ? 'drop-over' : ''}`}
                onDragEnter={(e) => {
                  requestDrop(e)
                  setDropOverFolderId(folder.id)
                  setIsDropOverUnfiled(false)
                }}
                onDragOver={(e) => {
                  requestDrop(e)
                  if (dropOverFolderId !== folder.id) setDropOverFolderId(folder.id)
                  if (isDropOverUnfiled) setIsDropOverUnfiled(false)
                }}
                onDragLeave={(e) => {
                  // Only clear when actually leaving the header element.
                  const nextTarget = e.relatedTarget as Node | null
                  if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
                    setDropOverFolderId((cur) => (cur === folder.id ? null : cur))
                  }
                }}
                onDrop={(e) => {
                  requestDrop(e)
                  const noteId = getDraggedNoteId(e.dataTransfer)
                  if (!noteId) return
                  onMoveNote(noteId, folder.id)
                  setExpandedFolders((prev) => {
                    const next = new Set(prev)
                    next.add(folder.id)
                    return next
                  })
                  setDropOverFolderId(null)
                  setIsDropOverUnfiled(false)
                }}
              >
                <button
                  className="folder-expand-btn"
                  onClick={() => toggleFolder(folder.id)}
                  title={isExpanded ? 'Collapse folder' : 'Expand folder'}
                >
                  <svg
                    className={`folder-chevron ${isExpanded ? 'expanded' : ''}`}
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </button>

                {isEditing ? (
                  <input
                    className="folder-name-input"
                    value={editingFolderName}
                    onChange={(e) => setEditingFolderName(e.target.value)}
                    onBlur={finishEditingFolder}
                    onDragEnter={(e) => requestDrop(e)}
                    onDragOver={(e) => requestDrop(e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') finishEditingFolder()
                      if (e.key === 'Escape') {
                        setEditingFolderId(null)
                        setEditingFolderName('')
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <div className="folder-name" onDoubleClick={() => startEditingFolder(folder)}>
                    {folder.name}
                    <span className="folder-count">{folderNotes.length}</span>
                  </div>
                )}

                <div className="folder-actions">
                  <button
                    className="folder-add-note-btn"
                    onClick={() => onNewNote(folder.id)}
                    title="New note in folder"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button
                    className="folder-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`Delete folder "${folder.name}"? Notes will be moved to unfiled.`)) {
                        onDeleteFolder(folder.id)
                      }
                    }}
                    title="Delete folder"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      <line x1="10" y1="11" x2="10" y2="17"></line>
                      <line x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                  </button>
                </div>
              </div>

              {isExpanded && folderNotes.length > 0 && (
                <div className="folder-notes">
                  {folderNotes.map(renderNote)}
                </div>
              )}
            </div>
          )
        })}

        {/* Unfiled Notes */}
        {unfiledNotes.length > 0 && (
          <div className="unfiled-section">
            <div
              className={`unfiled-header ${isDropOverUnfiled ? 'drop-over' : ''}`}
              onDragEnter={(e) => {
                requestDrop(e)
                setIsDropOverUnfiled(true)
                setDropOverFolderId(null)
              }}
              onDragOver={(e) => {
                requestDrop(e)
                if (!isDropOverUnfiled) setIsDropOverUnfiled(true)
                if (dropOverFolderId) setDropOverFolderId(null)
              }}
              onDragLeave={(e) => {
                const nextTarget = e.relatedTarget as Node | null
                if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
                  setIsDropOverUnfiled(false)
                }
              }}
              onDrop={(e) => {
                requestDrop(e)
                const noteId = getDraggedNoteId(e.dataTransfer)
                if (!noteId) return
                onMoveNote(noteId, undefined)
                setIsDropOverUnfiled(false)
                setDropOverFolderId(null)
              }}
            >
              Unfiled Notes
            </div>
            <div className="unfiled-notes">
              {unfiledNotes.map(renderNote)}
            </div>
          </div>
        )}
      </div>
      
      {/* Resize handle */}
      <div 
        className={`sidebar-resize-handle ${isResizing ? 'resizing' : ''}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  )
}

export default Sidebar
