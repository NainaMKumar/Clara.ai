import React from 'react';
import Navbar from '../components/Navbar';
import AdBanner from '../components/AdBanner';
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
      <AdBanner
        title='Try Clara Pro — faster AI, bigger context, and priority support.'
        description='Limited-time student discount available.'
        ctaText='Upgrade'
        href='#pricing'
        storageKey='clara_home_ad_dismissed_v1'
      />
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
