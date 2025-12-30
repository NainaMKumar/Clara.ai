import React from 'react';
import Navbar from '../components/Navbar';
import Hero from '../components/Hero';
import Features from '../components/Features';
import HowItWorks from '../components/HowItWorks';
import CTA from '../components/CTA';
import Footer from '../components/Footer';
import Founder from '../components/Founder';

const HomePage: React.FC = () => {
  return (
    <div className='home-page'>
      <Navbar />
      <Hero />
      <Features />
      <Founder />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  );
};

export default HomePage;
