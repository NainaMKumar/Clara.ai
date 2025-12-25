import React from 'react'
import Sidebar from '../components/Sidebar'
import NotesEditor from '../components/NotesEditor'
import './NotesPage.css'

const NotesPage: React.FC = () => {
  return (
    <div className="notes-page">
      <Sidebar />
      <NotesEditor />
    </div>
  )
}

export default NotesPage
