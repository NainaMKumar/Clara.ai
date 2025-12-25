import React, { useState } from 'react'
import './NotesEditor.css'

const NotesEditor: React.FC = () => {
  const [title, setTitle] = useState('Untitled Note')
  const [content, setContent] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [suggestion, setSuggestion] = useState('')
  const [deepgramSocket, setDeepgramSocket] = useState<WebSocket | null>(null)

  const handleRecordingToggle = () => {
    if (isRecording) {
      // Stop recording
      stopRecording()
    } else {
      // Start recording
      startRecording()
    }
  }

  const startRecording = async () => {
    const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY || ''
    const socket = new WebSocket('wss://api.deepgram.com/v1/listen', ['token', DEEPGRAM_API_KEY])

    socket.onopen = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data)
        }
      }
      mediaRecorder.start(250) // Send data in 250ms chunks

      // receive transcription results
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data)
        const transcript = data.channel?.alternatives?.[0]?.transcript
        if (transcript) {
          setSuggestion(transcript)
        }
      }
      setDeepgramSocket(socket)
    }
    
  }

  const stopRecording = () => {
    setIsRecording(false)
    // TODO: Integrate with audio recording API to stop and process
    console.log('Recording stopped...')
  }

  return (
    <div className="notes-editor">
      <div className="editor-header">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="note-title-input"
          placeholder="Note Title"
        />
      </div>
      <div className="editor-toolbar">
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
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="note-textarea"
          placeholder="Start typing your notes here..."
        />
      </div>
    </div>
  )
}

export default NotesEditor
