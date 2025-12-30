import React, { useEffect, useMemo, useState } from 'react';
import './AdBanner.css';

type AdBannerProps = {
  label?: string;
  title: string;
  description?: string;
  ctaText?: string;
  href?: string;
  storageKey?: string;
};

const AdBanner: React.FC<AdBannerProps> = ({
  label = 'Sponsored',
  title,
  description,
  ctaText = 'Learn more',
  href = '#',
  storageKey = 'clara_ad_dismissed_v1',
}) => {
  const [dismissed, setDismissed] = useState(false);

  const canPersist = useMemo(() => {
    try {
      return typeof window !== 'undefined' && !!window.localStorage;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!canPersist) return;
    try {
      setDismissed(window.localStorage.getItem(storageKey) === '1');
    } catch {
      // ignore
    }
  }, [canPersist, storageKey]);

  const onDismiss = () => {
    setDismissed(true);
    if (!canPersist) return;
    try {
      window.localStorage.setItem(storageKey, '1');
    } catch {
      // ignore
    }
  };

  if (dismissed) return null;

  return (
    <aside className='ad-banner' aria-label='Sponsored message'>
      <div className='ad-banner-inner'>
        <div className='ad-banner-text'>
          <div className='ad-banner-label'>{label}</div>
          <div className='ad-banner-title'>{title}</div>
          {description ? (
            <div className='ad-banner-description'>{description}</div>
          ) : null}
        </div>

        <div className='ad-banner-actions'>
          <a className='ad-banner-cta' href={href}>
            {ctaText}
          </a>
          <button
            type='button'
            className='ad-banner-dismiss'
            onClick={onDismiss}
            aria-label='Dismiss'
          >
            ×
          </button>
        </div>
      </div>
    </aside>
  );
};

export default AdBanner;
