import React from 'react'
import DemoVisual from './DemoVisual'
import './Hero.css'

const Hero: React.FC = () => {
  return (
    <section className="hero">
      <div className="hero-content">
        <h1>
          Take Notes Your Way, <span className="highlight">Powered by AI</span>
        </h1>
        <p>
          The flexible note-taking app built for students. Record lectures, get AI-powered
          autocompletion, and never miss a detail again.
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
