'use client';

import { useState, useEffect } from 'react';
import { decryptMessagePayload, MessageContentPayload, toShortUserId } from '@/lib/crypto';
import { RawMessageRow } from '@/hooks/useRealtimeChat';
import { MultiImageMosaic } from './MultiImageMosaic';
import { FileAttachmentCard } from './FileAttachmentCard';
import { getSenderColor } from '@/lib/senderColor';
import { REACTION_EMOJIS } from '@/hooks/useReactions';
import { Reply } from 'lucide-react';

interface MessageBubbleProps {
  message: RawMessageRow;
  currentUserId: string;
  senderName?: string;
  senderRole?: string;
  isGroupStart?: boolean;
  rmk: CryptoKey;
  lockGeneration: number;
  onOpenImage?: (messageId: string, index: number) => void;
  selected?: boolean;
  onSelect?: (messageId: string) => void;
  reactions?: Record<string, string>; // userId -> emoji
  onReact?: (messageId: string, emoji: string) => void;
  onReply?: (target: { id: string; name: string; text: string }) => void;
}

// A member could send any URL inside the ciphertext; only render GIPHY hosts so nobody can track viewers' IPs.
function isGiphyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'giphy.com' || u.hostname.endsWith('.giphy.com'));
  } catch {
    return false;
  }
}

export function MessageBubble({
  message,
  currentUserId,
  senderName,
  senderRole,
  isGroupStart = true,
  rmk,
  lockGeneration,
  onOpenImage,
  selected = false,
  onSelect,
  reactions,
  onReact,
  onReply,
}: MessageBubbleProps) {
  const [payload, setPayload] = useState<MessageContentPayload | null>(null);
  const [decryptError, setDecryptError] = useState(false);

  const isOutgoing = message.sender_id === currentUserId;

  useEffect(() => {
    let isCancelled = false;

    async function decrypt() {
      try {
        const decrypted = await decryptMessagePayload(
          rmk,
          message.room_id,
          message.id,
          message.encrypted_content,
          message.iv
        );
        if (!isCancelled) {
          setPayload(decrypted);
          setDecryptError(false);
        }
      } catch (err) {
        if (!isCancelled) {
          setDecryptError(true);
        }
      }
    }

    decrypt();

    return () => {
      isCancelled = true;
    };
  }, [message, rmk, lockGeneration]);

  // Format time (e.g. 19:42)
  const timeStr = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const reactionGroups = Object.values(reactions || {}).reduce<Record<string, number>>((acc, e) => {
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {});
  const myReaction = reactions?.[currentUserId];

  const handleSelect = (e: React.MouseEvent | React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    e.stopPropagation();
    onSelect?.(message.id);
  };

  const replyPreview = (): string => {
    if (!payload) return '';
    if (payload.text && message.media_type !== 'file') return payload.text.slice(0, 120);
    if (message.media_type === 'file') return payload.fileNames?.[0] || 'File';
    if (payload.gifUrl) return 'GIF';
    return message.media_count > 1 ? 'Photos' : 'Photo';
  };

  return (
    <div
      id={`msg-${message.id}`}
      className={`flex w-full flex-col ${isOutgoing ? 'items-end' : 'items-start'} ${isGroupStart ? 'mt-2.5' : 'mt-0.5'}`}
    >
      <div
        role="group"
        tabIndex={payload ? 0 : -1}
        onClick={handleSelect}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSelect(e); }}
        className={`max-w-[82%] rounded-2xl px-3 py-1.5 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-[#5288C1] ${
          isOutgoing
            ? `bg-[#2B5278] text-white ${isGroupStart ? 'rounded-tr-md' : ''}`
            : `bg-[#182533] text-white border border-[#242F3D] ${isGroupStart ? 'rounded-tl-md' : ''}`
        }`}
      >
        {decryptError ? (
          <span className="italic text-red-300">Decryption error</span>
        ) : !payload ? (
          <span className="text-[#7E90A3]">Decrypting...</span>
        ) : (
          <div className="space-y-1">
            {/* Sender Name & Role Header */}
            {!isOutgoing && isGroupStart && (
            <div className="flex items-center gap-1.5 pb-0.5">
              <span
                className="font-semibold text-xs tracking-tight truncate max-w-[190px]"
                style={{ color: getSenderColor(message.sender_id) }}
              >
                {senderName || `User_${toShortUserId(message.sender_id)}`}
              </span>
              {senderRole && senderRole !== 'member' && (
                <span
                  className={`rounded px-1.5 py-0.2 text-[8px] font-bold uppercase tracking-wider ${
                    senderRole === 'owner'
                      ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30'
                      : senderRole === 'admin'
                      ? 'bg-[#5288C1]/20 text-[#5288C1] border border-[#5288C1]/30'
                      : 'bg-red-500/20 text-red-400'
                  }`}
                >
                  {senderRole}
                </span>
              )}
            </div>
            )}

            {/* Quoted message this one replies to */}
            {payload.replyTo && (
              <button
                type="button"
                onClick={() => document.getElementById(`msg-${payload.replyTo!.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                className="mb-0.5 block w-full min-w-[9rem] rounded-md border-l-2 bg-black/20 px-2 py-1 text-left"
                style={{ borderColor: getSenderColor(payload.replyTo.id) }}
              >
                <span className="block truncate text-[11px] font-semibold text-[#5288C1]">{payload.replyTo.name}</span>
                <span className="block truncate text-xs text-[#B8C4D0]">{payload.replyTo.text}</span>
              </button>
            )}

            {/* Multi-Image Mosaic (Photos / Albums) */}
            {message.media_count > 0 && message.media_type !== 'file' && (
              <MultiImageMosaic
                roomId={message.room_id}
                messageId={message.id}
                mediaCount={message.media_count}
                mediaDeleted={message.media_deleted}
                rmk={rmk}
                lockGeneration={lockGeneration}
                onOpenImage={onOpenImage}
              />
            )}

            {/* Encrypted Document / File Attachment */}
            {message.media_type === 'file' && payload.fileNames && payload.fileNames.length > 0 && (
              <FileAttachmentCard
                roomId={message.room_id}
                messageId={message.id}
                fileName={payload.fileNames[0]}
                rmk={rmk}
                isOutgoing={isOutgoing}
              />
            )}

            {/* GIPHY GIF Render */}
            {payload.gifUrl && isGiphyUrl(payload.gifUrl) && (
              <div
                className="overflow-hidden rounded-xl bg-black/30"
                style={{
                  width: 'min(66vw, 260px)',
                  aspectRatio: payload.gifW && payload.gifH ? `${payload.gifW} / ${payload.gifH}` : '4 / 3',
                  maxHeight: 320,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={payload.gifUrl}
                  alt="GIF"
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </div>
            )}

            {/* Plaintext Body (if not a file or if file has extra caption) */}
            {payload.text && message.media_type !== 'file' && (
              <p className="whitespace-pre-wrap break-words leading-snug">
                {payload.text}
              </p>
            )}

            {/* Timestamp & Status */}
            <div className="flex items-center justify-end gap-1 pt-0.5 text-[10px] text-[#7E90A3]">
              <span>{timeStr}</span>
              {isOutgoing && (
                message.read_by_all_at ? (
                  <span title="Read by all active members" aria-label="Read by all" className="text-[#4ADE80]">✓✓</span>
                ) : (
                  <span title="Sent" aria-label="Sent">✓</span>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {Object.keys(reactionGroups).length > 0 && (
        <div className={`-mt-1 flex flex-wrap gap-1 px-1 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
          {Object.entries(reactionGroups).map(([emoji, n]) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onReact?.(message.id, emoji)}
              aria-label={`${emoji} ${n}${myReaction === emoji ? ', yours' : ''}`}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
                myReaction === emoji ? 'border-[#5288C1] bg-[#2B5278]' : 'border-[#242F3D] bg-[#17212B]'
              }`}
            >
              <span>{emoji}</span>
              {n > 1 && <span className="text-[10px] text-[#B8C4D0]">{n}</span>}
            </button>
          ))}
        </div>
      )}

      {selected && payload && (
        <div className={`mt-1 flex items-center gap-0.5 rounded-full border border-[#242F3D] bg-[#17212B] p-1 shadow-lg ${isOutgoing ? 'self-end' : 'self-start'}`}>
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => { onReact?.(message.id, emoji); onSelect?.(message.id); }}
              aria-label={`React ${emoji}`}
              className={`flex h-9 w-9 items-center justify-center rounded-full text-lg active:scale-90 ${myReaction === emoji ? 'bg-[#2B5278]' : 'hover:bg-[#242F3D]'}`}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { onReply?.({ id: message.id, name: isOutgoing ? 'You' : senderName || `User_${toShortUserId(message.sender_id)}`, text: replyPreview() }); onSelect?.(message.id); }}
            className="ml-0.5 flex h-9 items-center gap-1 rounded-full bg-[#242F3D] px-3 text-xs font-medium text-white hover:bg-[#2e3b4b]"
          >
            <Reply className="h-3.5 w-3.5" />
            Reply
          </button>
        </div>
      )}
    </div>
  );
}
