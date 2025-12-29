import React from 'react'
import { Note } from '../types'
import './Sidebar.css'

function stripHtml(html: string) {
  // Quick client-side strip for previews (keeps this dependency-free).
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim()
}

interface SidebarProps {
  notes: Note[]
  onSelectNote: (id: string) => void
  onNewNote: () => void
  onDeleteNote: (id: string) => void
  selectedNoteId: string | null
}

const Sidebar: React.FC<SidebarProps> = ({ notes, onSelectNote, onNewNote, onDeleteNote, selectedNoteId }) => {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>My Notes</h2>
        <button className="new-note-btn" onClick={onNewNote}>
          + New Note
        </button>
      </div>
      <div className="notes-list">
        {notes.map(note => (
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
        ))}
      </div>
    </div>
  )
}

export default Sidebar
