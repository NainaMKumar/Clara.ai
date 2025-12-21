import React from 'react'
import DemoVisual from './DemoVisual'
import './Hero.css'

const Hero: React.FC = () => {
  return (
    <section className="hero">
      <div className="hero-content">
        <h1>
          Notetaking like, <span className="highlight">Vibecoding.</span>
        </h1>
        <p>
          Clara is the first AI-powered notetaking app that integrates into your notetaking workflow.
          We want you to take the notes. 
          We want you to be in control. 
          But let us make your life a little easier.
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
