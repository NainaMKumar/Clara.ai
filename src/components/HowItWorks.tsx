import React from 'react'
import './HowItWorks.css'
import diagram from './how_it_works_3.png'

// interface Step {
//   number: number
//   title: string
//   description: string
// }

// const steps: Step[] = [
//   {
//     number: 1,
//     title: 'Start Recording',
//     description: 'Open Clara and hit record when your lecture begins. The app captures audio while you focus on key concepts.'
//   },
//   {
//     number: 2,
//     title: 'Write Your Notes',
//     description: "Type naturally in your own style. Clara's AI understands context from both your writing and the lecture audio."
//   },
//   {
//     number: 3,
//     title: 'Press TAB to Complete',
//     description: 'Missed something or need to catch up? Press TAB and Clara intelligently completes your sentence based on lecture context.'
//   },
//   {
//     number: 4,
//     title: 'Enhance & Review',
//     description: 'After class, ask Clara to reformat, add comments, or clarify concepts. Your notes become a comprehensive study guide.'
//   }
// ]

const HowItWorks: React.FC = () => {
  return (
    <section className="how-it-works" id="how-it-works">
      <h2>How It Works</h2>
      <img src={diagram} alt="Diagram" className="diagram"/>
      {/* <div className="steps">
        {steps.map((step) => (
          <div key={step.number} className="step">
            <div className="step-number">{step.number}</div>
            <div className="step-content">
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </div>
          </div>
        ))}
      </div> */}
    </section>
  )
}

export default HowItWorks
