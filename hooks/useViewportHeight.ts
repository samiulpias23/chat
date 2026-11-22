'use client';

import { useEffect } from 'react';

// Manages dynamic visualViewport height adjustments for mobile Android Chrome
export function useViewportHeight() {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const updateViewport = () => {
      const vv = window.visualViewport;
      if (!vv) return;

      const height = vv.height;
      const offsetTop = vv.offsetTop;

      document.documentElement.style.setProperty('--viewport-height', `${height}px`);
      document.documentElement.style.setProperty('--viewport-offset', `${offsetTop}px`);
    };

    updateViewport();

    const vv = window.visualViewport;
    vv.addEventListener('resize', updateViewport);
    vv.addEventListener('scroll', updateViewport);

    return () => {
      vv.removeEventListener('resize', updateViewport);
      vv.removeEventListener('scroll', updateViewport);
    };
  }, []);
}
