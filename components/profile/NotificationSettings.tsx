'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { disablePush, enablePush, isPushEnabled, isPushSupported } from '@/lib/push';

export function NotificationSettings() {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isPushSupported());
    isPushEnabled().then(setEnabled).catch(() => {});
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (enabled) await disablePush();
      else await enablePush();
      setEnabled(!enabled);
    } catch (err) {
      const blocked = isPushSupported() && Notification.permission === 'denied';
      setError(
        blocked
          ? 'Notifications are blocked. Allow them for this site in your browser settings, then try again.'
          : err instanceof Error ? err.message : 'Could not change notifications. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 rounded-2xl bg-[#17212B] p-5 border border-[#242F3D]">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-2">
          <Bell className="mt-0.5 h-4 w-4 shrink-0 text-[#5288C1]" />
          <div>
            <h3 id="notifications-label" className="text-sm font-semibold text-white">Allow Notifications</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[#7E90A3]">
              Get “You got a message” for rooms you have unlocked. Message content is never shown.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="notifications-label"
          onClick={toggle}
          disabled={busy || !supported}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 disabled:cursor-default disabled:opacity-40 ${
            enabled ? 'bg-[#5288C1]' : 'bg-[#242F3D]'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      {!supported && (
        <p className="mt-3 text-[11px] text-amber-300">
          This browser can’t receive notifications. On iPhone or iPad, add ChatAf to your Home Screen and open it from there.
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
