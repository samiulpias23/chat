'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

export function useRoomReadReceipt(roomId: string, isUnlocked: boolean, messageCount: number) {
  const prevUnlockedRef = useRef<boolean>(false);
  const lastMarkedRef = useRef<number>(0);

  useEffect(() => {
    if (!isUnlocked || !roomId) {
      prevUnlockedRef.current = isUnlocked;
      return;
    }

    const supabase = createClient();
    const wasJustUnlocked = !prevUnlockedRef.current && isUnlocked;
    prevUnlockedRef.current = isUnlocked;

    const now = Date.now();
    // Mark read immediately upon unlocking, or debounced on incoming messages
    if (wasJustUnlocked || now - lastMarkedRef.current > 1500) {
      lastMarkedRef.current = now;
      supabase.rpc('mark_room_read', { p_room_id: roomId }).then(({ error }) => {
        if (error) console.warn('mark_room_read error:', error.message);
      });
    }
  }, [roomId, isUnlocked, messageCount]);
}
