import React, { useState, useEffect } from 'react'
import './NotesEditor.css'

const NotesEditor: React.FC = () => {
  const [title, setTitle] = useState('Untitled Note')
  const [isRecording, setIsRecording] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [deepgramSocket, setDeepgramSocket] = useState<WebSocket | null>(null)
  const contentEditableRef = React.useRef<HTMLDivElement>(null)
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const mediaStreamRef = React.useRef<MediaStream | null>(null)
  const [mode, setMode] = useState<'autocomplete' | 'suggestion'>('suggestion')
  const typingTimerRef = React.useRef<number | null>(null)
  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false)

  // Manage suggestion display in the DOM
  useEffect(() => {
    if (contentEditableRef.current) {
      // Remove any existing suggestion spans
      const existingSuggestions = contentEditableRef.current.querySelectorAll('.suggestion-text')
      existingSuggestions.forEach(span => span.remove())

      if (suggestion) {
        const selection = window.getSelection()
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0)
          const span = document.createElement('span')
          span.className = 'suggestion-text'
          span.textContent = suggestion
          span.contentEditable = 'false'

          // Insert the suggestion at cursor position
          const suggestionRange = range.cloneRange()
          suggestionRange.collapse(true)
          suggestionRange.insertNode(span)

          // Keep cursor position before the suggestion
          const newRange = document.createRange()
          newRange.setStartBefore(span)
          newRange.setEndBefore(span)
          selection.removeAllRanges()
          selection.addRange(newRange)
        }
      }
    }
  }, [suggestion])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab' && suggestion) {
      e.preventDefault()
      // Accept the suggestion by replacing the suggestion span with text
      if (contentEditableRef.current) {
        const suggestionSpan = contentEditableRef.current.querySelector('.suggestion-text')
        if (suggestionSpan) {
          const textNode = document.createTextNode(suggestion)
          suggestionSpan.replaceWith(textNode)

          // Move cursor after the inserted text
          const selection = window.getSelection()
          if (selection) {
            const range = document.createRange()
            range.setStartAfter(textNode)
            range.setEndAfter(textNode)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
      setSuggestion('')
    } else if ((e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') && suggestion) {
      // User is typing or deleting - clear the suggestion
      setSuggestion('')
    }
  }

  const handleRecordingToggle = () => {
    if (isRecording) {
      // Stop recording
      stopRecording()
    } else {
      // Start recording
      startRecording()
    }
  }

  const fetchAISuggestion = async(typedText: string, spokenTranscript: string) =>  {
    const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content: 'You help complete text. The user spoke a sentence and typed part of it. Output ONLY the remaining words they spoke but haven\'t typed yet. Do not repeat what they already typed. Do not rephrase. Extract only the untyped portion.'
              },
              {
                role: 'user',
                content: `What was recorded: "${spokenTranscript}"\n What the user typed: "${typedText}"\n\nOnly output the remaining words:`
              }
            ],
            max_tokens: 100,
            temperature: 0.2
          })
        })

        const data = await response.json()
        return data.choices[0].message.content
  }

  const handleInput = () => {
    if (mode != 'suggestion') return 

    // clear existing timer
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
    }
    // clear existing suggestion while typing
    setSuggestion('')
    typingTimerRef.current = setTimeout(async () => {
      // current user text
      const currentText = contentEditableRef.current?.textContent || ''
      // transcript context
      const context = currentText + (transcript ? '' + transcript : '')

      if (context.trim().length > 10) {
        setIsLoadingSuggestion(true)
        try {
          const aiSuggestion = await fetchAISuggestion(currentText, context)
          setSuggestion(aiSuggestion)
          setTranscript('')
        } catch (error) {
          console.error('Failed to fetch AI suggestion',error)
        } finally {
          setIsLoadingSuggestion(false)
        }
      }
    }, 1500) // 1.5 second pause
  }

  const startRecording = async () => {
    const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY || ''
    const socket = new WebSocket('wss://api.deepgram.com/v1/listen', ['token', DEEPGRAM_API_KEY])

    socket.onopen = async () => {
      setIsRecording(true)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })

      mediaStreamRef.current = stream
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data)
        }
      }
      mediaRecorder.start(250) // Send data in 250ms chunks

      // receive transcription results
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data)
        const transcriptText = data.channel?.alternatives?.[0]?.transcript
        if (transcriptText) {
          setTranscript(prev => prev + ' ' + transcriptText)
          if (mode == 'autocomplete') {
            setSuggestion(prev => prev + ' ' + transcriptText)
          }
          
        }
      }
      setDeepgramSocket(socket)
    }

  }

  const stopRecording = () => {
    setIsRecording(false)
    if (mediaRecorderRef) {
      mediaRecorderRef.current?.stop()
      mediaRecorderRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop())
      mediaStreamRef.current = null
    }

    // close the Deepgram websocket
    if (deepgramSocket) {
      deepgramSocket.close()
      setDeepgramSocket(null)
    }

    setTranscript('')
    setSuggestion('')

    // clear active timer
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
    }

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
          className={`mode-button ${mode === 'autocomplete' ? 'active' : ''}`}
          onClick={() => setMode('autocomplete')}
          title="Autocomplete mode"
        >
          Autocomplete
        </button>

        <button 
          className={`mode-button ${mode === 'suggestion' ? 'active': ''}`}
          onClick={() => setMode('suggestion')}
          title="suggestion mode"
        >
          Suggestion
        </button>
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
        <div
          ref={contentEditableRef}
          contentEditable="true"
          className="note-textarea"
          data-placeholder="Start typing your notes here..."
          onKeyDown={handleKeyDown}
          onInput={handleInput}
        />
      </div>
    </div>
  )
}

export default NotesEditor