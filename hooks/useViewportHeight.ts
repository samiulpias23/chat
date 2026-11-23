'use client';

import { useEffect } from 'react';

// Tracks the visual viewport so a fixed chat shell always fits above the soft keyboard.
// Chrome/Android honours `interactive-widget=resizes-content` (see app/layout.tsx), where this is a no-op
// (offset 0, height == layout height). iOS Safari ignores it, so we pin the shell to the visual viewport.
// Updates are rAF-batched and de-duplicated to avoid layout thrash while the keyboard animates.
export function useViewportHeight(enabled = true) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;

    const root = document.documentElement;
    let frame = 0;
    let lastH = -1;
    let lastTop = -1;

    const apply = () => {
      frame = 0;
      const h = Math.round(vv.height);
      const top = Math.round(vv.offsetTop);
      if (h !== lastH) {
        lastH = h;
        root.style.setProperty('--viewport-height', `${h}px`);
      }
      if (top !== lastTop) {
        lastTop = top;
        root.style.setProperty('--viewport-offset', `${top}px`);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    root.classList.add('chat-open');

    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      root.classList.remove('chat-open');
      root.style.removeProperty('--viewport-height');
      root.style.removeProperty('--viewport-offset');
    };
  }, [enabled]);
}
