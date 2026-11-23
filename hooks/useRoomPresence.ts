'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const TYPING_REFRESH_MS = 4000; // at most one presence update per 4 s while typing
const TYPING_IDLE_MS = 3000; // stop after 3 s without a keystroke
const TYPING_STALE_MS = 8000; // receivers drop a typing flag that was not refreshed

interface PresenceMeta {
  typing?: boolean;
  ts?: number;
}

// Who is on screen in this room (unlocked, foreground) and who is typing.
// Locking removes the channel, so a locked or backgrounded member leaves immediately.
export function useRoomPresence(roomId: string, userId: string | undefined, enabled: boolean) {
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<string[]>([]);

  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null);
  const readyRef = useRef(false);
  const sendState = useRef({ typing: false, lastSent: 0 });
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTyping = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    const s = sendState.current;
    if (!s.typing || !readyRef.current) {
      s.typing = false;
      return;
    }
    s.typing = false;
    s.lastSent = Date.now();
    channelRef.current?.track({ typing: false, ts: Date.now() });
  }, []);

  const notifyTyping = useCallback(() => {
    if (!readyRef.current) return;
    const s = sendState.current;
    const now = Date.now();
    if (!s.typing || now - s.lastSent > TYPING_REFRESH_MS) {
      s.typing = true;
      s.lastSent = now;
      channelRef.current?.track({ typing: true, ts: now });
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [stopTyping]);

  useEffect(() => {
    if (!enabled || !roomId || !userId) return;

    const supabase = createClient();
    const channel = supabase.channel(`room:${roomId}:live`, {
      config: { private: true, presence: { key: userId } },
    });
    channelRef.current = channel;

    const order: string[] = []; // stable left-to-right order by first sighting
    const seen = new Map<string, { ts: number; at: number }>();
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const recompute = () => {
      if (cancelled) return;
      const state = channel.presenceState<PresenceMeta>();
      const now = Date.now();
      const typingNow: string[] = [];
      let nextExpiry = Infinity;

      for (const key of Object.keys(state)) {
        if (key === userId) continue;
        if (!order.includes(key)) order.push(key);
        const metas = state[key] || [];
        const latest = metas.reduce<PresenceMeta>((a, m) => ((m.ts ?? 0) >= (a.ts ?? 0) ? m : a), {});
        if (!latest.typing) {
          seen.delete(key);
          continue;
        }
        const prev = seen.get(key);
        const entry = prev && prev.ts === latest.ts ? prev : { ts: latest.ts ?? 0, at: now };
        seen.set(key, entry);
        const left = TYPING_STALE_MS - (now - entry.at);
        if (left > 0) {
          typingNow.push(key);
          nextExpiry = Math.min(nextExpiry, left);
        }
      }

      const onlineNow = order.filter((k) => k in state && k !== userId);
      setOnline((prev) => (prev.join() === onlineNow.join() ? prev : onlineNow));
      setTyping((prev) => (prev.join() === typingNow.join() ? prev : typingNow));

      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = nextExpiry < Infinity ? setTimeout(recompute, nextExpiry + 50) : null;
    };

    channel
      .on('presence', { event: 'sync' }, recompute)
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          readyRef.current = true;
          await channel.track({ typing: false, ts: Date.now() });
        }
      });

    return () => {
      cancelled = true;
      readyRef.current = false;
      sendState.current = { typing: false, lastSent: 0 };
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (expiryTimer) clearTimeout(expiryTimer);
      channelRef.current = null;
      supabase.removeChannel(channel);
      setOnline([]);
      setTyping([]);
    };
  }, [roomId, userId, enabled]);

  return { online, typing, notifyTyping, stopTyping };
}
