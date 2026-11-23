'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { ChevronDown, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth/AuthProvider';
import { useAfkLock } from '@/hooks/useAfkLock';
import { useRealtimeChat } from '@/hooks/useRealtimeChat';
import { useRoomReadReceipt } from '@/hooks/useRoomReadReceipt';
import { useRoomPresence } from '@/hooks/useRoomPresence';
import { useReactions } from '@/hooks/useReactions';
import { useViewportHeight } from '@/hooks/useViewportHeight';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { RoomLockScreen } from '@/components/chat/RoomLockScreen';
import { RoomSettingsModal } from '@/components/chat/RoomSettingsModal';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { MessageComposer } from '@/components/chat/MessageComposer';
import { PresenceDock } from '@/components/chat/PresenceDock';
import { RawGalleryModal, type GalleryItem } from '@/components/chat/RawGalleryModal';
import { toShortUserId } from '@/lib/crypto';

interface RoomMeta {
  id: string;
  name: string;
  status: string;
  expires_at: string | null;
  owner_id?: string;
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
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

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [showJump, setShowJump] = useState(false);
  const stickRef = useRef(true);

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

  // Who is on screen and who is typing (channel is removed on lock, so locked members disappear at once)
  const { online, typing, notifyTyping, stopTyping } = useRoomPresence(roomId, user?.id, !isLocked && !!rmkRef.current);
  const presenceNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of online) out[id] = membersMap[id]?.name || `User_${toShortUserId(id)}`;
    return out;
  }, [online, membersMap]);

  const { reactions, toggle: toggleReaction } = useReactions(roomId, user?.id, !isLocked && !!rmkRef.current);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; name: string; text: string } | null>(null);
  const handleSelect = useCallback((id: string) => setSelectedId((p) => (p === id ? null : id)), []);
  const handleReply = useCallback((t: { id: string; name: string; text: string }) => setReplyTo(t), []);
  const clearReply = useCallback(() => setReplyTo(null), []);

  // Locking wipes plaintext held in UI state (reply quote, open viewer, selection)
  useEffect(() => {
    if (isLocked) {
      setReplyTo(null);
      setSelectedId(null);
      setViewer(null);
    }
  }, [isLocked]);

  // Every live photo in the room, oldest first, so the viewer can swipe across messages
  const galleryItems = useMemo<GalleryItem[]>(() => {
    const out: GalleryItem[] = [];
    for (const m of messages) {
      if (m.media_deleted || m.media_count < 1 || (m.media_type !== 'photo' && m.media_type !== 'album')) continue;
      for (let i = 0; i < m.media_count; i++) out.push({ messageId: m.id, index: i, count: m.media_count });
    }
    return out;
  }, [messages]);
  const [viewer, setViewer] = useState<{ messageId: string; index: number } | null>(null);
  const closeViewer = useCallback(() => setViewer(null), []);
  const openImage = useCallback((messageId: string, index: number) => setViewer({ messageId, index }), []);

  // Read Receipt trigger (starts 24h countdown once all active members read)
  useRoomReadReceipt(roomId, !isLocked, messages.length);

  // Fit the fixed shell to the visual viewport only while the chat itself is on screen
  useViewportHeight(!isLocked && !!room);

  const snapToBottom = useCallback(() => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }, [scrollEl]);

  // Stay pinned to the bottom (instantly, no animation) whenever the list or its viewport changes size:
  // keyboard open/close, composer growing, images/decrypted bubbles loading, new messages.
  useEffect(() => {
    if (!scrollEl) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) snapToBottom();
    });
    ro.observe(scrollEl);
    if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
    return () => ro.disconnect();
  }, [scrollEl, snapToBottom]);

  // New message: follow it if we're at the bottom or we sent it
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && last.sender_id === user?.id) stickRef.current = true;
    if (stickRef.current) snapToBottom();
  }, [messages, user?.id, snapToBottom]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = nearBottom;
    setShowJump((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
  }, [scrollEl]);

  const handleFocusInput = useCallback(() => {
    stickRef.current = true;
  }, []);

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
      style={{ top: 'var(--viewport-offset, 0px)', height: 'var(--viewport-height, 100dvh)' }}
      className="fixed inset-x-0 flex flex-col bg-[#0E1621] text-white overflow-hidden"
    >
      {/* Header */}
      <ChatHeader
        roomName={room.name}
        onLockClick={() => lock()}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Messages Feed: Messages anchored to bottom like Telegram */}
      <div className="relative flex-1 min-h-0">
      <div
        ref={setScrollEl}
        onScroll={handleScroll}
        onClick={() => setSelectedId(null)}
        className="chat-scroll h-full overflow-y-auto overscroll-contain px-3"
      >
        <div className={`flex min-h-full flex-col justify-end pt-3 ${online.length > 0 ? 'pb-10' : 'pb-3'}`}>
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
            messages.map((m, i) => {
              const prev = messages[i - 1];
              const member = membersMap[m.sender_id];
              const senderName = member?.name || `User_${toShortUserId(m.sender_id)}`;
              const senderRole = member?.role;
              const day = new Date(m.created_at).toDateString();
              const newDay = !prev || new Date(prev.created_at).toDateString() !== day;
              const groupStart =
                newDay ||
                prev.sender_id !== m.sender_id ||
                new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > 5 * 60 * 1000;

              return (
                <div key={m.id} className="contents">
                  {newDay && (
                    <div className="my-3 flex justify-center">
                      <span className="rounded-full bg-[#17212B]/90 px-3 py-0.5 text-[11px] font-medium text-[#7E90A3]">
                        {formatDayLabel(m.created_at)}
                      </span>
                    </div>
                  )}
                  <MessageBubble
                    message={m}
                    currentUserId={user?.id || ''}
                    senderName={senderName}
                    senderRole={senderRole}
                    isGroupStart={groupStart}
                    rmk={rmkRef.current!}
                    lockGeneration={lockGeneration}
                    onOpenImage={openImage}
                    selected={selectedId === m.id}
                    onSelect={handleSelect}
                    reactions={reactions[m.id]}
                    onReact={toggleReaction}
                    onReply={handleReply}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full border border-[#242F3D] bg-[#17212B] text-[#5288C1] shadow-lg active:scale-95"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      )}
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
          onTyping={notifyTyping}
          onStopTyping={stopTyping}
          replyTo={replyTo}
          onCancelReply={clearReply}
          dock={<PresenceDock online={online} typing={typing} names={presenceNames} />}
        />
      )}

      {viewer && rmkRef.current && (
        <RawGalleryModal
          roomId={room.id}
          items={galleryItems}
          startMessageId={viewer.messageId}
          startIndex={viewer.index}
          rmk={rmkRef.current}
          onClose={closeViewer}
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
