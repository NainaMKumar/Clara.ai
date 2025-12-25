import React from 'react'
import DemoVisual from './DemoVisual'
import './Hero.css'

const Hero: React.FC = () => {
  return (
    <section className="hero">
      <div className="hero-content">
        <h1>
          AI That Writes <span className="highlight"> With You.</span>
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
