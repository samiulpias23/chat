'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

// messageId -> userId -> emoji
export type ReactionMap = Record<string, Record<string, string>>;

interface ReactionRow {
  message_id: string;
  user_id: string;
  emoji: string;
}

function put(prev: ReactionMap, r: ReactionRow): ReactionMap {
  return { ...prev, [r.message_id]: { ...prev[r.message_id], [r.user_id]: r.emoji } };
}

function drop(prev: ReactionMap, messageId: string, userId: string): ReactionMap {
  const cur = prev[messageId];
  if (!cur || !(userId in cur)) return prev;
  const { [userId]: _removed, ...rest } = cur;
  const next = { ...prev };
  if (Object.keys(rest).length) next[messageId] = rest;
  else delete next[messageId];
  return next;
}

export function useReactions(roomId: string, userId: string | undefined, enabled: boolean) {
  const [reactions, setReactions] = useState<ReactionMap>({});
  const reactionsRef = useRef(reactions);
  reactionsRef.current = reactions;

  useEffect(() => {
    if (!enabled || !roomId) return;
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const { data } = await supabase.from('message_reactions').select('message_id, user_id, emoji').eq('room_id', roomId);
      if (cancelled || !data) return;
      const map: ReactionMap = {};
      for (const r of data as ReactionRow[]) map[r.message_id] = { ...map[r.message_id], [r.user_id]: r.emoji };
      setReactions(map);
    };

    const channel = supabase
      .channel(`room:${roomId}:reactions`, { config: { private: true } })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions', filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old as Partial<ReactionRow>;
            if (old.message_id && old.user_id) setReactions((p) => drop(p, old.message_id!, old.user_id!));
          } else {
            setReactions((p) => put(p, payload.new as ReactionRow));
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') load();
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [roomId, enabled]);

  // Optimistic toggle; the realtime echo (or a reload) confirms it
  const toggle = useCallback(
    async (messageId: string, emoji: string) => {
      if (!userId) return;
      const before = reactionsRef.current;
      const mine = before[messageId]?.[userId];
      setReactions((p) => (mine === emoji ? drop(p, messageId, userId) : put(p, { message_id: messageId, user_id: userId, emoji })));
      const { error } = await createClient().rpc('toggle_reaction', { p_message_id: messageId, p_emoji: emoji });
      if (error) setReactions(before);
    },
    [userId]
  );

  return { reactions, toggle };
}
