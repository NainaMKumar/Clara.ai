import React, { useState, useEffect } from 'react'
import DemoVisual from './DemoVisual'
import './Hero.css'

const Hero: React.FC = () => {
  const [displayedText, setDisplayedText] = useState('')
  const [showCursor, setShowCursor] = useState(true)
  const fullText = 'AI That Writes With You'

  useEffect(() => {
    let currentIndex = 0
    const typingInterval = setInterval(() => {
      if (currentIndex <= fullText.length) {
        setDisplayedText(fullText.slice(0, currentIndex))
        currentIndex++
      } else {
        clearInterval(typingInterval)
        setShowCursor(false)
      }
    }, 100) // Adjust speed here (milliseconds per character)

    return () => clearInterval(typingInterval)
  }, [])

  return (
    <section className="hero">
      <div className="hero-content">
        <h1>
          <span className="typed-text">{displayedText}</span>
          {showCursor && <span className="cursor">|</span>}
        </h1>
        <p>
          Clara is a real time, collaborative AI for notetaking. 
          No recording, no uploads, no AI-generated summaries. 
          Just intelligent assistance as you think, type, and learn.
        </p>
        <div className="hero-buttons">
          <button className="btn-primary">Start Free Trial</button>
          <button className="btn-secondary">Watch Demo</button>
        </div>
      </div>
      <DemoVisual />
    </section>
  )
}

export default Hero
