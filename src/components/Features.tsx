import React from 'react'
import './Features.css'

interface Feature {
  icon: string
  title: string
  description: string
}

const features: Feature[] = [
  {
    icon: '',
    title: 'Record Lectures',
    description: 'Capture every word with built-in audio recording. Focus on understanding while Clara transcribes your lecture in real-time.'
  },
  {
    icon: '',
    title: 'TAB Autocompletion',
    description: 'Missed something? Just press TAB and let AI fill in the blanks based on your notes and the lecture transcript at that moment.'
  },
  {
    icon: '',
    title: 'In-Note AI Assistance',
    description: 'Get intelligent comments, suggestions, and formatting help. Transform your messy notes into structured, organized documents.'
  },
  // {
  //   icon: '',
  //   title: 'Your Style, Your Way',
  //   description: 'Write notes how you want. Clara adapts to your style while offering help when you need it.'
  // },
  // {
  //   icon: '',
  //   title: 'Smart Reformatting',
  //   description: 'Transform messy lecture notes into organized, structured documents with one click.'
  // },
  // {
  //   icon: '',
  //   title: 'Contextual Comments',
  //   description: 'AI adds helpful explanations, definitions, and connections to make your notes more valuable.'
  // }
]

const Features: React.FC = () => {
  return (
    <section className="features" id="features">
      <h2>Intelligent Assistance for Notetaking</h2>
      <div className="features-grid">
        {features.map((feature, index) => (
          <div key={index} className="feature-card">
            <div className="feature-icon">{feature.icon}</div>
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

export default Features
