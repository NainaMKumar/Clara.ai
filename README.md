# Clara.ai

AI-powered note-taking app built for students that seamlessly combines voice transcription with intelligent text completion. Clara gives you the flexibility of writing your own notes while AI assists you in real-time.

## Features

### 🎙️ Real-time Voice Transcription
Record lectures or meetings using Deepgram's speech-to-text API. Your recording is transcribed in real time as you take notes

### 🔄 Dual Input Modes

**Autocomplete Mode**
- Voice transcription appears as inline gray text
- Press TAB to accept and insert the transcribed text
- Perfect for capturing lectures verbatim

**Suggestion Mode**
- Type naturally while recording
- Pause typing to trigger AI suggestions
- Get smart completions that match your writing style
- Press TAB to accept suggestions

### 📝 Markdown Support
Full markdown rendering in the notes editor for rich formatting.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Deepgram API key ([Get one here](https://deepgram.com))
- OpenAI API key ([Get one here](https://platform.openai.com))

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/clara.ai.git
cd clara.ai

# Install dependencies
npm install

# Create .env file and add your API keys
echo "VITE_DEEPGRAM_API_KEY=your_deepgram_key_here" > .env
echo "VITE_OPENAI_API_KEY=your_openai_key_here" >> .env

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Usage

1. **Select your mode**: Choose between Autocomplete or Suggestion mode using the toggle
2. **Start recording**: Click the "Start Recording" button and grant microphone permissions
3. **Take notes**: Begin typing your notes while speaking
4. **Accept suggestions**: Press TAB when you see gray inline suggestions
5. **Stop recording**: Click "Stop Recording" when finished

## Color Scheme

- Dark: `#191A19`
- Dark Green: `#1E5128`
- Medium Green: `#4E9F3D`
- Light Green: `#D8E9A8`

## Tech Stack

- React 18
- TypeScript
- Vite
- CSS3

## License

MIT
