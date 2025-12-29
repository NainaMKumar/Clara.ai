import React from 'react'
import './Footer.css'


const Footer: React.FC = () => {
  return (
    <footer className="footer">
      <p>&copy; 2024 Clara.ai - Built for Students, Powered by AI</p>
      <p className="footer-links">
        <a href="#">Privacy Policy</a> | 
        <a href="#"> Terms of Service</a> | 
        <a href="#"> Contact Us</a>
      </p>
    </footer>
  )
}

export default Footer
