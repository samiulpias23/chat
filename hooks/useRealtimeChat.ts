'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';

export interface RawMessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  encrypted_content: string;
  iv: string;
  media_type: 'text' | 'photo' | 'album' | 'file' | 'gif';
  media_count: number;
  media_deleted: boolean;
  created_at: string;
  read_by_all_at: string | null;
  expires_at: string;
}

export function useRealtimeChat(roomId: string, isUnlocked: boolean) {
  const [messages, setMessages] = useState<RawMessageRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch initial unexpired messages
  const fetchMessages = useCallback(async () => {
    if (!isUnlocked || !roomId) return;
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true });

      if (!error && data) {
        setMessages(data as RawMessageRow[]);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, [roomId, isUnlocked]);

  useEffect(() => {
    if (!isUnlocked || !roomId) return;

    fetchMessages();

    const supabase = createClient();

    // Subscribe to private channel 'room:<uuid>'
    const channel = supabase.channel(`room:${roomId}`, {
      config: { private: true },
    });

    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as RawMessageRow]);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === payload.new.id ? (payload.new as RawMessageRow) : m))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, isUnlocked, fetchMessages]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, isLoading, refetch: fetchMessages, clearMessages };
}
