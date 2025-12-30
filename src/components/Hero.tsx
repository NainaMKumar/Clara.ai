import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import DemoVisual from './DemoVisual'
import './Hero.css'

const Hero: React.FC = () => {
  const [displayedText, setDisplayedText] = useState('')
  const [showCursor] = useState(true)
  const fullText = 'AI That Writes With You'

  useEffect(() => {
    let currentIndex = 0
    let isDeleting = false
    let typingSpeed = 100

    const type = () => {
      if (!isDeleting && currentIndex <= fullText.length) {
        setDisplayedText(fullText.slice(0, currentIndex))
        currentIndex++
        typingSpeed = 100
      } else if (!isDeleting && currentIndex > fullText.length) {
        // Finished typing, wait before deleting
        typingSpeed = 2000
        isDeleting = true
      } else if (isDeleting && currentIndex > 0) {
        // Deleting
        currentIndex--
        setDisplayedText(fullText.slice(0, currentIndex))
        typingSpeed = 50
      } else if (isDeleting && currentIndex === 0) {
        // Finished deleting, wait before typing again
        isDeleting = false
        typingSpeed = 500
      }

      setTimeout(type, typingSpeed)
    }

    const timeout = setTimeout(type, typingSpeed)
    return () => clearTimeout(timeout)
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
          <Link to="/notes" className="btn-primary">Start Free Trial</Link>
          <button className="btn-secondary">Watch Demo</button>
        </div>
      </div>
      <DemoVisual />
    </section>
  )
}

export default Hero
