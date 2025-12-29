import React from 'react'
import './DemoVisual.css'
import prototype from './prototype.png'

const DemoVisual: React.FC = () => {
  return (
    <div className="demo-visual">
      <img src={prototype} alt="Prototype" className="prototype"/>
      {/* <div className="demo-window">
        <div className="demo-header">
          <div className="dot"></div>
          <div className="dot"></div>
          <div className="dot"></div>
        </div>
        <div className="demo-content">
          <div className="demo-line"># Lecture 5: Photosynthesis</div>
          <div className="demo-line"></div>
          <div className="demo-line">Light-dependent reactions occur in the thylakoid membrane...</div>
          <div className="demo-line">- Chlorophyll absorbs light energy</div>
          <div className="demo-line">
            - Water molecules are split to release{' '}
            <span className="tab-hint">TAB to complete</span>
          </div>
          <div className="demo-line recording">Recording... 15:23</div>
        </div>
      </div> */}
    </div>
  )
}

export default DemoVisual
