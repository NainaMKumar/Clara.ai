import React from 'react'
import './Founder.css'
import naina_profile from './picture of me.jpg'
import aadivya_profile from './aadivya.jpg'

const Founder: React.FC = () => {
  return (
    <section className="founders">
      <div className="founder-content">
        <h1>
          {/* AI That Writes <span className="highlight"> With You.</span> */}
          Why did we build Clara? 
        </h1>
        {/* <p className="uiuc">
          <em> From students at the University of Illinois Urbana-Champaign </em>
        </p> */}
        <div className="founders-container">
          <div className="founder-card">
            <img src={naina_profile} alt="Naina Kumar" className="profile-photo"/>
            <p className="founder-major">CS + BioE @ UIUC</p>
            <p className="founder-why">I built Clara because I realized I could not understand my notes once lecture was over. I could not find a notetaking app that actually worked like an intelligent assistant, so I could focus on learning rather than writing. </p>
          </div>

          <div className="founder-card">
            <img src={aadivya_profile} alt="Aadivya Raushan" className="profile-photo"/>
            <p className="founder-major">CS @ UIUC</p>
            <p className="founder-why">I wanted to create a tool that helps students focus on learning rather than frantically trying to capture everything. Clara makes note-taking effortless so you can be present in class.</p>
          </div>
        </div>
        
      </div>
    </section>
  )
}

export default Founder