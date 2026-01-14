import React from 'react'
import { Link } from 'react-router-dom'
import './Navbar.css'
import clara_logo from './logo_design_2.png'

const Navbar: React.FC = () => {
  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/" className="logo">
          <img className="clara-logo" src={clara_logo} alt="Clara Logo" />
        </Link>
        <ul className="nav-links">
          <li><a href="#features">Features</a></li>
          <li><a href="#how-it-works">How It Works</a></li>
          <li><a href="#pricing">Pricing</a></li>
          <li><Link to="/notes" className="cta-button">Get Started</Link></li>
        </ul>
      </div>
    </nav>
  )
}

export default Navbar
