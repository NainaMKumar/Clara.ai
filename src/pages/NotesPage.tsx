import React, { useState } from 'react'
import Sidebar from '../components/Sidebar'
import NotesEditor from '../components/NotesEditor'
import { Note } from '../types'
import './NotesPage.css'

const NotesPage: React.FC = () => {
  const [notes, setNotes] = useState<Note[]>([
    {
      id: '1',
      title: 'Welcome to Clara',
      content: 'Start taking notes here...',
      date: new Date().toLocaleDateString()
    }
  ])
  
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>('1')

  const handleNoteSelect = (id: string) => {
    setSelectedNoteId(id)
  }

  const handleNewNote = () => {
    const newNote: Note = {
      id: Date.now().toString(),
      title: 'New Note',
      content: '',
      date: new Date().toLocaleDateString()
    }
    setNotes([newNote, ...notes])
    setSelectedNoteId(newNote.id)
  }

  const handleNoteUpdate = (id: string, updatedFields: Partial<Note>) => {
    setNotes(notes.map(note => 
      note.id === id ? { ...note, ...updatedFields, date: new Date().toLocaleDateString() } : note
    ))
  }

  const handleDeleteNote = (id: string) => {
    const newNotes = notes.filter(note => note.id !== id)
    setNotes(newNotes)
    if (selectedNoteId === id) {
      setSelectedNoteId(null)
    }
  }

  const selectedNote = notes.find(n => n.id === selectedNoteId)

  return (
    <div className="notes-page">
      <Sidebar 
        notes={notes} 
        onSelectNote={handleNoteSelect} 
        onNewNote={handleNewNote}
        onDeleteNote={handleDeleteNote}
        selectedNoteId={selectedNoteId}
      />
      {selectedNote ? (
        <NotesEditor 
          note={selectedNote} 
          onUpdate={(fields) => handleNoteUpdate(selectedNote.id, fields)}
        />
      ) : (
        <div className="no-note-selected">
          <p>Select a note or create a new one</p>
        </div>
      )}
    </div>
  )
}

export default NotesPage
