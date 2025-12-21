import React from 'react'
import './Navbar.css'

const Navbar: React.FC = () => {
  return (
    <nav className="navbar">
      <div className="navbar-container">
        <div className="logo">
          Clara<span>.ai</span>
        </div>
        <ul className="nav-links">
          <li><a href="#features">Features</a></li>
          <li><a href="#how-it-works">How It Works</a></li>
          <li><a href="#pricing">Pricing</a></li>
          <li><a href="#" className="cta-button">Get Started</a></li>
        </ul>
      </div>
    </nav>
  )
}

export default Navbar
