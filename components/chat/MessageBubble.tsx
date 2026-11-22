'use client';

import { useState, useEffect } from 'react';
import { decryptMessagePayload, MessageContentPayload, toShortUserId } from '@/lib/crypto';
import { RawMessageRow } from '@/hooks/useRealtimeChat';
import { MultiImageMosaic } from './MultiImageMosaic';
import { FileAttachmentCard } from './FileAttachmentCard';

interface MessageBubbleProps {
  message: RawMessageRow;
  currentUserId: string;
  senderName?: string;
  senderRole?: string;
  rmk: CryptoKey;
  lockGeneration: number;
}

const SENDER_COLORS = [
  '#4ADE80', // green
  '#38BDF8', // sky blue
  '#E879F9', // purple/fuchsia
  '#FBBF24', // amber/gold
  '#FB7185', // rose/pink
  '#34D399', // emerald
  '#60A5FA', // blue
  '#A78BFA', // violet
];

function getSenderColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SENDER_COLORS[hash % SENDER_COLORS.length];
}

export function MessageBubble({
  message,
  currentUserId,
  senderName,
  senderRole,
  rmk,
  lockGeneration,
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

  return (
    <div className={`flex w-full flex-col ${isOutgoing ? 'items-end' : 'items-start'} my-1`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs shadow-md ${
          isOutgoing
            ? 'bg-[#2B5278] text-white rounded-br-sm'
            : 'bg-[#182533] text-white rounded-bl-sm border border-[#242F3D]'
        }`}
      >
        {decryptError ? (
          <span className="italic text-red-300">Decryption error</span>
        ) : !payload ? (
          <span className="text-[#7E90A3]">Decrypting...</span>
        ) : (
          <div className="space-y-1">
            {/* Sender Name & Role Header */}
            <div className="flex items-center gap-1.5 pb-0.5">
              <span
                className="font-bold text-[11px] tracking-tight truncate max-w-[190px]"
                style={{ color: isOutgoing ? '#79c0ff' : getSenderColor(message.sender_id) }}
              >
                {senderName || (isOutgoing ? 'You' : `User_${toShortUserId(message.sender_id)}`)}
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

            {/* Multi-Image Mosaic (Photos / Albums) */}
            {message.media_count > 0 && message.media_type !== 'file' && (
              <MultiImageMosaic
                roomId={message.room_id}
                messageId={message.id}
                mediaCount={message.media_count}
                mediaDeleted={message.media_deleted}
                rmk={rmk}
                lockGeneration={lockGeneration}
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
            {payload.gifUrl && (
              <div className="overflow-hidden rounded-xl bg-black/30">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={payload.gifUrl}
                  alt="GIF"
                  className="max-h-60 w-full object-cover"
                />
              </div>
            )}

            {/* Plaintext Body (if not a file or if file has extra caption) */}
            {payload.text && message.media_type !== 'file' && (
              <p className="whitespace-pre-wrap break-words leading-relaxed text-sm">
                {payload.text}
              </p>
            )}

            {/* Timestamp & Status */}
            <div className="flex items-center justify-end gap-1 pt-0.5 text-[10px] text-[#7E90A3]">
              <span>{timeStr}</span>
              {message.read_by_all_at && (
                <span title="Read by all active members" className="text-[#4ADE80]">
                  ✓✓
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
