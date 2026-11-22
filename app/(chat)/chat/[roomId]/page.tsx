'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth/AuthProvider';
import { useAfkLock } from '@/hooks/useAfkLock';
import { useRealtimeChat } from '@/hooks/useRealtimeChat';
import { useRoomReadReceipt } from '@/hooks/useRoomReadReceipt';
import { useViewportHeight } from '@/hooks/useViewportHeight';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { RoomLockScreen } from '@/components/chat/RoomLockScreen';
import { RoomSettingsModal } from '@/components/chat/RoomSettingsModal';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { MessageComposer } from '@/components/chat/MessageComposer';
import { toShortUserId } from '@/lib/crypto';

interface RoomMeta {
  id: string;
  name: string;
  status: string;
  expires_at: string | null;
  owner_id?: string;
}

export default function ChatRoomPage() {
  const params = useParams();
  const roomId = params?.roomId as string;

  const { user } = useAuth();
  const [room, setRoom] = useState<RoomMeta | null>(null);
  const [isLoadingRoom, setIsLoadingRoom] = useState(true);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [membersMap, setMembersMap] = useState<Record<string, { name: string; role?: string }>>({});

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Reliable scroll-to-bottom helper that works with keyboard resizing
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      if (behavior === 'auto') {
        container.scrollTop = container.scrollHeight;
      } else {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth',
        });
      }
    }
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  // Android Chrome virtual viewport keyboard height adjuster
  useViewportHeight();

  // AFK & Instant Background Lock Hook
  const {
    isLocked,
    lockGeneration,
    rmkRef,
    lock,
    unlock,
    suspendForPicker,
    resumeFromPicker,
  } = useAfkLock({ idleTimeoutMs: 15000 });

  // Realtime Chat Hook (active only when unlocked)
  const { messages, isLoading: isLoadingMessages, clearMessages } = useRealtimeChat(
    roomId,
    !isLocked && !!rmkRef.current
  );

  // Read Receipt trigger (starts 24h countdown once all active members read)
  useRoomReadReceipt(roomId, !isLocked, messages.length);

  // Scroll to bottom on initial message load
  useEffect(() => {
    if (!isLoadingMessages && messages.length > 0) {
      scrollToBottom('auto');
    }
  }, [isLoadingMessages, scrollToBottom]);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    scrollToBottom('smooth');
  }, [messages.length, scrollToBottom]);

  // Auto-scroll when mobile virtual keyboard opens/resizes visual viewport
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;

    const handleViewportChange = () => {
      scrollToBottom('smooth');
    };

    vv.addEventListener('resize', handleViewportChange);
    vv.addEventListener('scroll', handleViewportChange);

    return () => {
      vv.removeEventListener('resize', handleViewportChange);
      vv.removeEventListener('scroll', handleViewportChange);
    };
  }, [scrollToBottom]);

  const handleFocusInput = useCallback(() => {
    scrollToBottom('smooth');
    setTimeout(() => scrollToBottom('smooth'), 80);
    setTimeout(() => scrollToBottom('smooth'), 200);
    setTimeout(() => scrollToBottom('smooth'), 350);
  }, [scrollToBottom]);

  // Load room members to display sender names and roles
  useEffect(() => {
    async function loadMembers() {
      if (!roomId || isLocked) return;
      try {
        const supabase = createClient();
        const { data, error } = await supabase.rpc('get_room_members', { p_room_id: roomId });
        if (!error && Array.isArray(data)) {
          const map: Record<string, { name: string; role?: string }> = {};
          for (const m of data) {
            map[m.user_id] = {
              name: m.nickname || m.display_name || `User_${toShortUserId(m.user_id)}`,
              role: m.role,
            };
          }
          setMembersMap(map);
        }
      } catch {
        // Silently ignore
      }
    }
    loadMembers();
  }, [roomId, isLocked]);

  // Fetch room metadata
  useEffect(() => {
    async function loadRoom() {
      if (!roomId) return;
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from('rooms')
          .select('id, name, status, expires_at, owner_id')
          .eq('id', roomId)
          .single();

        if (error || !data) {
          throw new Error('Room not found or unauthorized.');
        }

        const isExpired = data.expires_at ? new Date(data.expires_at).getTime() <= Date.now() : false;
        if (isExpired) {
          throw new Error('This room has expired. The owner must renew it to resume chatting.');
        }

        setRoom(data as RoomMeta);
      } catch (err: any) {
        setRoomError(err.message || 'Could not load room.');
      } finally {
        setIsLoadingRoom(false);
      }
    }

    loadRoom();
  }, [roomId]);

  if (isLoadingRoom) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#0E1621] text-[#7E90A3]">
        <Loader2 className="h-6 w-6 animate-spin text-[#5288C1]" />
      </div>
    );
  }

  if (roomError || !room) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#0E1621] p-4 text-white">
        <div className="w-full max-w-sm rounded-2xl bg-[#17212B] p-6 text-center border border-[#242F3D]">
          <ShieldAlert className="mx-auto h-10 w-10 text-red-400" />
          <h2 className="mt-3 text-base font-semibold">Access Notice</h2>
          <p className="mt-2 text-xs text-[#7E90A3] leading-relaxed">{roomError || 'Room unavailable'}</p>
          <a
            href="/rooms"
            className="mt-5 inline-block rounded-xl bg-[#242F3D] px-4 py-2 text-xs font-medium text-[#5288C1] hover:bg-[#2e3b4b]"
          >
            Back to Rooms
          </a>
        </div>
      </div>
    );
  }

  // 15s AFK & Instant Background Lock Screen overlay
  if (isLocked || !rmkRef.current) {
    return (
      <RoomLockScreen
        roomId={room.id}
        roomName={room.name}
        onUnlocked={(rmk) => unlock(rmk)}
      />
    );
  }

  return (
    <div
      style={{ height: 'var(--viewport-height, 100dvh)' }}
      className="fixed inset-0 flex flex-col bg-[#0E1621] text-white overflow-hidden"
    >
      {/* Header */}
      <ChatHeader
        roomName={room.name}
        onLockClick={() => lock()}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Messages Feed: Messages anchored to bottom like Telegram */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3">
        <div className="flex min-h-full flex-col justify-end pt-3 pb-6 space-y-2.5">
          {isLoadingMessages ? (
            <div className="flex h-40 items-center justify-center text-[#7E90A3]">
              <Loader2 className="h-5 w-5 animate-spin text-[#5288C1]" />
            </div>
          ) : messages.length === 0 ? (
            <div className="my-auto flex flex-col items-center justify-center text-center text-[#7E90A3] py-12">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#17212B] text-[#5288C1] mb-3 border border-[#242F3D]">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <p className="text-sm font-semibold text-white">End-to-End Encrypted Room</p>
              <p className="mt-1 text-xs text-[#7E90A3] max-w-xs leading-relaxed">
                Messages and files are encrypted with AES-256-GCM. Decryption keys live in RAM and self-wipe after 15 seconds of inactivity.
              </p>
            </div>
          ) : (
            messages.map((m) => {
              const member = membersMap[m.sender_id];
              const isMe = m.sender_id === user?.id;
              const rawName = member?.name || `User_${toShortUserId(m.sender_id)}`;
              const senderName = isMe ? `${rawName} (You)` : rawName;
              const senderRole = member?.role;

              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  currentUserId={user?.id || ''}
                  senderName={senderName}
                  senderRole={senderRole}
                  rmk={rmkRef.current!}
                  lockGeneration={lockGeneration}
                />
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Message Composer */}
      {user && rmkRef.current && (
        <MessageComposer
          roomId={room.id}
          senderId={user.id}
          rmk={rmkRef.current}
          onSuspendPicker={suspendForPicker}
          onResumePicker={resumeFromPicker}
          onFocusInput={handleFocusInput}
          onExpandChange={() => {
            setTimeout(() => {
              scrollToBottom('smooth');
            }, 60);
          }}
        />
      )}

      {/* Room Info & Settings Modal */}
      <RoomSettingsModal
        roomId={room.id}
        roomName={room.name}
        expiresAt={room.expires_at}
        isOwner={room.owner_id === user?.id}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onLockNow={() => lock()}
      />
    </div>
  );
}
