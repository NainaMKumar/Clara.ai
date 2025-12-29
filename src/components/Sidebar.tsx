import React, { useState } from 'react'
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
  onNewFolder: () => void
  onDeleteFolder: (id: string) => void
  onRenameFolder: (id: string, name: string) => void
  selectedNoteId: string | null
}

const Sidebar: React.FC<SidebarProps> = ({
  notes,
  folders,
  onSelectNote,
  onNewNote,
  onDeleteNote,
  onNewFolder,
  onDeleteFolder,
  onRenameFolder,
  selectedNoteId
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(folders.map(f => f.id))
  )
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')

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

  const renderNote = (note: Note) => (
    <div
      key={note.id}
      className={`note-item ${selectedNoteId === note.id ? 'active' : ''}`}
      onClick={() => onSelectNote(note.id)}
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
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>My Notes</h2>
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

          return (
            <div key={folder.id} className="folder-section">
              <div className="folder-header">
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
            <div className="unfiled-header">Unfiled Notes</div>
            <div className="unfiled-notes">
              {unfiledNotes.map(renderNote)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Sidebar
