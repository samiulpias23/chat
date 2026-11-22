'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { objectUrlRegistry } from '@/lib/urlRegistry';
import { getSecuritySettings, ClientSecuritySettings } from '@/lib/securitySettings';

interface UseAfkLockOptions {
  onLock?: () => void;
  idleTimeoutMs?: number; // optional manual override
}

export function useAfkLock({
  onLock,
  idleTimeoutMs: customIdleTimeoutMs,
}: UseAfkLockOptions = {}) {
  const [isLocked, setIsLocked] = useState(true);
  const [lockGeneration, setLockGeneration] = useState(0);
  const [settings, setSettings] = useState<ClientSecuritySettings>(() => getSecuritySettings());

  // Listen for live client settings changes
  useEffect(() => {
    const handleSettingsChange = (e: Event) => {
      const custom = e as CustomEvent<ClientSecuritySettings>;
      if (custom.detail) {
        setSettings(custom.detail);
      } else {
        setSettings(getSecuritySettings());
      }
    };
    window.addEventListener('chataf_settings_changed', handleSettingsChange);
    return () => window.removeEventListener('chataf_settings_changed', handleSettingsChange);
  }, []);

  const idleTimeoutMs = customIdleTimeoutMs ?? (settings.afkTimeoutSeconds * 1000);
  const afkEnabled = settings.afkLockEnabled;
  const minimizeEnabled = settings.minimizeLockEnabled;
  const minimizeTimeoutMs = settings.minimizeTimeoutSeconds * 1000;

  // References held in volatile memory
  const rmkRef = useRef<CryptoKey | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Picker suspension tracking with 60s hard timeout
  const isSelectingMediaRef = useRef<boolean>(false);
  const pickerTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Deadline-based idle tracking (resilient to mobile background timer throttling)
  const idleDeadlineRef = useRef<number>(performance.now() + idleTimeoutMs);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Minimize background timer & timestamp tracking
  const hiddenTimestampRef = useRef<number | null>(null);
  const minimizeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const lock = useCallback(() => {
    // 1. Bump lock generation & abort in-flight decrypts
    setLockGeneration((prev) => prev + 1);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = new AbortController();
    }

    // 2. Clear volatile cryptographic keys
    rmkRef.current = null;

    // 3. Revoke all media Object URLs
    objectUrlRegistry.revokeAll();

    // 4. Trigger caller state purge
    onLock?.();

    // 5. Mount lock screen
    setIsLocked(true);
  }, [onLock]);

  const unlock = useCallback((rmk: CryptoKey) => {
    rmkRef.current = rmk;
    abortControllerRef.current = new AbortController();
    setIsLocked(false);
    idleDeadlineRef.current = performance.now() + idleTimeoutMs;
    hiddenTimestampRef.current = null;
    if (minimizeTimerRef.current) {
      clearTimeout(minimizeTimerRef.current);
      minimizeTimerRef.current = null;
    }
  }, [idleTimeoutMs]);

  const resetIdleTimer = useCallback(() => {
    idleDeadlineRef.current = performance.now() + idleTimeoutMs;
  }, [idleTimeoutMs]);

  // Media Picker suspension handler (Photo / Camera button)
  const suspendForPicker = useCallback(() => {
    isSelectingMediaRef.current = true;
    if (pickerTimeoutRef.current) clearTimeout(pickerTimeoutRef.current);
    // Hard 60-second safety timeout in case picker cancel event does not fire
    pickerTimeoutRef.current = setTimeout(() => {
      isSelectingMediaRef.current = false;
    }, 60000);
  }, []);

  const resumeFromPicker = useCallback(() => {
    isSelectingMediaRef.current = false;
    if (pickerTimeoutRef.current) clearTimeout(pickerTimeoutRef.current);
    resetIdleTimer();
  }, [resetIdleTimer]);

  useEffect(() => {
    if (isLocked) return;

    // 1. Lock on tab switch, app minimize, or screen off
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (!isSelectingMediaRef.current && minimizeEnabled) {
          if (minimizeTimeoutMs === 0) {
            lock();
          } else {
            hiddenTimestampRef.current = Date.now();
            if (minimizeTimerRef.current) clearTimeout(minimizeTimerRef.current);
            minimizeTimerRef.current = setTimeout(() => {
              lock();
            }, minimizeTimeoutMs);
          }
        }
      } else {
        // App returned to foreground
        if (minimizeTimerRef.current) {
          clearTimeout(minimizeTimerRef.current);
          minimizeTimerRef.current = null;
        }

        // If OS paused JavaScript while backgrounded, check actual wall-clock elapsed time
        if (minimizeEnabled && hiddenTimestampRef.current !== null) {
          const elapsed = Date.now() - hiddenTimestampRef.current;
          hiddenTimestampRef.current = null;
          if (elapsed >= minimizeTimeoutMs) {
            lock();
            return;
          }
        }

        // Becoming visible again, check AFK inactivity deadline
        if (afkEnabled && performance.now() >= idleDeadlineRef.current) {
          lock();
        }
      }
    };

    const handlePageHide = () => {
      if (!isSelectingMediaRef.current && minimizeEnabled) {
        if (minimizeTimeoutMs === 0) {
          lock();
        } else {
          hiddenTimestampRef.current = Date.now();
        }
      }
    };

    // BFCache restoration check
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted && minimizeEnabled) {
        lock();
      }
    };

    // Window blur check (desktop only, ignore on touch devices)
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const handleBlur = () => {
      if (!isTouchDevice && !isSelectingMediaRef.current && minimizeEnabled && minimizeTimeoutMs === 0) {
        lock();
      }
    };

    // 2. Inactivity Tracking
    const checkIdle = () => {
      if (!afkEnabled || isSelectingMediaRef.current) return;
      const now = performance.now();
      if (now >= idleDeadlineRef.current) {
        lock();
      } else {
        idleTimerRef.current = setTimeout(checkIdle, Math.max(500, idleDeadlineRef.current - now));
      }
    };

    if (afkEnabled) {
      idleTimerRef.current = setTimeout(checkIdle, idleTimeoutMs);
    }

    // Monitored physical user inputs
    const inputEvents = ['pointerdown', 'keydown', 'input', 'touchstart', 'scroll'];
    const handleUserInput = () => {
      resetIdleTimer();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('blur', handleBlur);

    inputEvents.forEach((evt) => {
      window.addEventListener(evt, handleUserInput, { passive: true });
    });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('blur', handleBlur);

      inputEvents.forEach((evt) => {
        window.removeEventListener(evt, handleUserInput);
      });

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (pickerTimeoutRef.current) clearTimeout(pickerTimeoutRef.current);
      if (minimizeTimerRef.current) clearTimeout(minimizeTimerRef.current);
    };
  }, [isLocked, lock, idleTimeoutMs, afkEnabled, minimizeEnabled, minimizeTimeoutMs, resetIdleTimer]);

  return {
    isLocked,
    lockGeneration,
    rmkRef,
    abortSignal: abortControllerRef.current?.signal,
    lock,
    unlock,
    resetIdleTimer,
    suspendForPicker,
    resumeFromPicker,
  };
}
