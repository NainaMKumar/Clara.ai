import React from 'react'
import { Note } from '../types'
import './Sidebar.css'

interface SidebarProps {
  notes: Note[]
  onSelectNote: (id: string) => void
  onNewNote: () => void
  selectedNoteId: string | null
}

const Sidebar: React.FC<SidebarProps> = ({ notes, onSelectNote, onNewNote, selectedNoteId }) => {
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
            <p>{note.content.substring(0, 50) || 'No additional text'}{note.content.length > 50 ? '...' : ''}</p>
            <span className="note-date">{note.date}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Sidebar
