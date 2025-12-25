import React, { useState, useEffect, useRef, useMemo } from 'react'
import SimpleMDE from 'react-simplemde-editor'
import EasyMDE from 'easymde'
import 'easymde/dist/easymde.min.css'
import { Note } from '../types'
import './NotesEditor.css'

interface NotesEditorProps {
  note: Note
  onUpdate: (fields: Partial<Note>) => void
}

const NotesEditor: React.FC<NotesEditorProps> = ({ note, onUpdate }) => {
  const [isRecording, setIsRecording] = useState(false)
  const [deepgramSocket, setDeepgramSocket] = useState<WebSocket | null>(null)
  
  // Use a ref to keep track of content for the socket callback without stale closures
  const contentRef = useRef(note.content)

  useEffect(() => {
    contentRef.current = note.content
  }, [note.content])

  const mdeOptions = useMemo(() => {
    return {
      spellChecker: false,
      placeholder: 'Start typing your notes here...',
      status: false,
      autosave: {
        enabled: false,
        uniqueId: note.id,
        delay: 1000,
      },
      toolbar: [
        'bold', 'italic', 
        {
          name: 'heading-1',
          action: EasyMDE.toggleHeading1,
          className: 'fa fa-header fa-header-x fa-header-1',
          title: 'Heading 1',
        },
        {
          name: 'heading-2',
          action: EasyMDE.toggleHeading2,
          className: 'fa fa-header fa-header-x fa-header-2',
          title: 'Heading 2',
        },
        {
          name: 'heading-3',
          action: EasyMDE.toggleHeading3,
          className: 'fa fa-header fa-header-x fa-header-3',
          title: 'Heading 3',
        },
        '|', 
        'quote', 'unordered-list', 'ordered-list', '|',
        'link', 'image'
      ]
    }
  }, [note.id])

  const handleRecordingToggle = () => {
    if (isRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  const startRecording = async () => {
    const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY || ''
    const socket = new WebSocket('wss://api.deepgram.com/v1/listen', ['token', DEEPGRAM_API_KEY])

    socket.onopen = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
        
        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
            socket.send(event.data)
          }
        }
        mediaRecorder.start(250)

        socket.onmessage = (message) => {
          const data = JSON.parse(message.data)
          const transcript = data.channel?.alternatives?.[0]?.transcript
          if (transcript) {
            // Append transcript to current content
            const newContent = (contentRef.current ? contentRef.current + ' ' : '') + transcript
            onUpdate({ content: newContent })
          }
        }
        setDeepgramSocket(socket)
        setIsRecording(true)
      } catch (error) {
        console.error('Error accessing microphone:', error)
        setIsRecording(false)
      }
    }
  }

  const stopRecording = () => {
    setIsRecording(false)
    if (deepgramSocket) {
      deepgramSocket.close()
      setDeepgramSocket(null)
    }
  }

  return (
    <div className="notes-editor">
      <div className="editor-header">
        <input
          type="text"
          value={note.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="note-title-input"
          placeholder="Note Title"
        />
      </div>
      <div className="notes-actions">
        <button
          className={`record-button ${isRecording ? 'recording' : ''}`}
          onClick={handleRecordingToggle}
          title={isRecording ? 'Stop Recording' : 'Start Recording'}
        >
          <span className="record-icon"></span>
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>
      </div>
      <div className="editor-content">
        <SimpleMDE
          value={note.content}
          onChange={(value) => onUpdate({ content: value })}
          options={mdeOptions}
          className="note-mde"
        />
      </div>
    </div>
  )
}

export default NotesEditor
