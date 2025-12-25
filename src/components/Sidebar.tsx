import React, { useState } from 'react'
import './Sidebar.css'

interface Note {
  id: string
  title: string
  preview: string
  date: string
}

const Sidebar: React.FC = () => {
  const [notes, setNotes] = useState<Note[]>([
    {
      id: '1',
      title: 'Welcome to Clara',
      preview: 'Start taking notes here...',
      date: new Date().toLocaleDateString()
    }
  ])

  const handleNewNote = () => {
    const newNote: Note = {
      id: Date.now().toString(),
      title: 'New Note',
      preview: '',
      date: new Date().toLocaleDateString()
    }
    setNotes([newNote, ...notes])
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>My Notes</h2>
        <button className="new-note-btn" onClick={handleNewNote}>
          + New Note
        </button>
      </div>
      <div className="notes-list">
        {notes.map(note => (
          <div key={note.id} className="note-item">
            <h3>{note.title}</h3>
            <p>{note.preview}</p>
            <span className="note-date">{note.date}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Sidebar
