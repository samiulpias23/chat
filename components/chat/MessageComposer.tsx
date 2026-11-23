'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Plus, Image as ImageIcon, Camera, Smile, Loader2, FileText, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { encryptMessagePayload, encryptMediaBlob, MessageContentPayload, generateUUID } from '@/lib/crypto';
import { GiphyPicker } from './GiphyPicker';

interface MessageComposerProps {
  roomId: string;
  senderId: string;
  rmk: CryptoKey;
  onSuspendPicker: () => void;
  onResumePicker: () => void;
  onFocusInput?: () => void;
  onTyping?: () => void;
  onStopTyping?: () => void;
  dock?: React.ReactNode;
  replyTo?: { id: string; name: string; text: string } | null;
  onCancelReply?: () => void;
}

export function MessageComposer({
  roomId,
  senderId,
  rmk,
  onSuspendPicker,
  onResumePicker,
  onFocusInput,
  onTyping,
  onStopTyping,
  dock,
  replyTo,
  onCancelReply,
}: MessageComposerProps) {
  const [sendError, setSendError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = (msg: string) => {
    setSendError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setSendError(null), 5000);
  };
  useEffect(() => () => { if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showTray, setShowTray] = useState(false);
  const [showGiphy, setShowGiphy] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);

  // Handle generic encrypted document / file upload (up to 26MB)
  const handleDocumentSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    onResumePicker();
    const file = e.target.files?.[0];
    if (!file || isSending) return;

    if (file.size > 26 * 1024 * 1024) {
      showError('File is larger than the 26 MB limit.');
      return;
    }

    setIsSending(true);
    setShowTray(false);

    try {
      const supabase = createClient();
      const messageId = generateUUID();
      const rawBuffer = await file.arrayBuffer();

      // 1. Encrypt raw document binary bytes directly to Storage slot raw-0
      const encryptedBlob = await encryptMediaBlob(rmk, roomId, messageId, 'raw-0', rawBuffer);
      const rawPath = `${roomId}/${messageId}/raw-0.enc`;
      const { error: rawErr } = await supabase.storage.from('chat-media').upload(rawPath, encryptedBlob, {
        contentType: 'application/octet-stream',
        upsert: false,
      });
      if (rawErr) throw rawErr;

      // 2. Encrypt message payload with original file name
      const payload: MessageContentPayload = {
        fileNames: [file.name],
        text: file.name,
        ...(replyTo ? { replyTo } : {}),
      };
      const { encryptedContent, iv } = await encryptMessagePayload(rmk, roomId, messageId, payload);

      // 3. Insert message row with media_type = 'file'
      const { error: msgErr } = await supabase.from('messages').insert({
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        encrypted_content: encryptedContent,
        iv,
        media_type: 'file',
        media_count: 1,
      });

      if (msgErr) throw msgErr;
      onCancelReply?.();
    } catch (err: any) {
      showError(err.message || 'File upload failed.');
    } finally {
      setIsSending(false);
      if (documentInputRef.current) documentInputRef.current.value = '';
    }
  };

  // Helper to generate 160px WebP thumbnail from an image file
  const generateThumbnailWebP = (file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 160;
        let w = img.width;
        let h = img.height;

        if (w > h) {
          if (w > maxDim) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          }
        } else {
          if (h > maxDim) {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas 2D context unavailable'));

        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          async (blob) => {
            if (!blob) return reject(new Error('Canvas blob generation failed'));
            resolve(await blob.arrayBuffer());
          },
          'image/webp',
          0.65
        );
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  };

  // Send pure text or GIF message
  const handleSendMessage = async (basePayload: MessageContentPayload, mediaType: 'text' | 'gif' = 'text') => {
    if (isSending) return;
    const payload: MessageContentPayload = replyTo ? { ...basePayload, replyTo } : basePayload;
    setIsSending(true);

    try {
      const supabase = createClient();
      const messageId = generateUUID();

      // 1. Encrypt payload with RMK
      const { encryptedContent, iv } = await encryptMessagePayload(rmk, roomId, messageId, payload);

      // 2. Insert into Supabase messages table
      const { error } = await supabase.from('messages').insert({
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        encrypted_content: encryptedContent,
        iv,
        media_type: mediaType,
        media_count: 0,
      });

      if (error) throw error;
      onStopTyping?.();
      onCancelReply?.();
      setText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = '40px';
      }
      setShowGiphy(false);
      setShowTray(false);
    } catch (err: any) {
      showError(err.message || 'Could not send. Check your connection and try again.');
    } finally {
      setIsSending(false);
    }
  };

  // Handle multi-image file selection (up to 10 photos)
  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    onResumePicker();
    const files = Array.from(e.target.files || []).slice(0, 10);
    if (files.length === 0 || isSending) return;

    setIsSending(true);
    setShowTray(false);

    try {
      const supabase = createClient();
      const messageId = generateUUID();
      const fileNames = files.map((f) => f.name);

      // 1. Encrypt and upload each thumbnail and raw lossless photo directly to Storage
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const rawBuffer = await file.arrayBuffer();
        const thumbBuffer = await generateThumbnailWebP(file);

        // Encrypt thumbnail
        const encryptedThumbBlob = await encryptMediaBlob(rmk, roomId, messageId, `thumb-${i}`, thumbBuffer);
        const thumbPath = `${roomId}/${messageId}/thumb-${i}.enc`;
        const { error: thumbErr } = await supabase.storage.from('chat-media').upload(thumbPath, encryptedThumbBlob, {
          contentType: 'application/octet-stream',
          upsert: false,
        });
        if (thumbErr) throw thumbErr;

        // Encrypt raw lossless image
        const encryptedRawBlob = await encryptMediaBlob(rmk, roomId, messageId, `raw-${i}`, rawBuffer);
        const rawPath = `${roomId}/${messageId}/raw-${i}.enc`;
        const { error: rawErr } = await supabase.storage.from('chat-media').upload(rawPath, encryptedRawBlob, {
          contentType: 'application/octet-stream',
          upsert: false,
        });
        if (rawErr) throw rawErr;
      }

      // 2. Encrypt message payload referencing filenames
      const payload: MessageContentPayload = { fileNames, ...(replyTo ? { replyTo } : {}) };
      const { encryptedContent, iv } = await encryptMessagePayload(rmk, roomId, messageId, payload);

      // 3. Insert message row
      const { error: msgErr } = await supabase.from('messages').insert({
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        encrypted_content: encryptedContent,
        iv,
        media_type: files.length > 1 ? 'album' : 'photo',
        media_count: files.length,
      });

      if (msgErr) throw msgErr;
      onCancelReply?.();
    } catch (err: any) {
      showError(err.message || 'Media upload failed.');
    } finally {
      setIsSending(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  };

  const handleOpenPhotoPicker = () => {
    // Hide keyboard only when selecting media
    textareaRef.current?.blur();
    onSuspendPicker();
    fileInputRef.current?.click();
  };

  const handleOpenCameraPicker = () => {
    textareaRef.current?.blur();
    onSuspendPicker();
    cameraInputRef.current?.click();
  };

  const handleOpenDocumentPicker = () => {
    textareaRef.current?.blur();
    onSuspendPicker();
    documentInputRef.current?.click();
  };

  const handleOpenGiphyPicker = () => {
    textareaRef.current?.blur();
    setShowTray(false);
    setShowGiphy(true);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (e.target.value.trim()) onTyping?.();
    else onStopTyping?.();
    const target = e.target;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() && !isSending) {
        handleSendMessage({ text: text.trim() });
      }
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
    onFocusInput?.();
  };

  const handleBlur = () => {
    setIsFocused(false);
    onStopTyping?.();
  };

  return (
    <div className="relative shrink-0 w-full z-20 bg-[#17212B] border-t border-[#242F3D]/60 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {dock}
      {sendError && (
        <p role="alert" className="mb-2 rounded-xl bg-red-950/70 px-3 py-1.5 text-xs text-red-200">
          {sendError}
        </p>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border-l-2 border-[#5288C1] bg-[#242F3D] py-1.5 pl-3 pr-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold text-[#5288C1]">Replying to {replyTo.name}</p>
            <p className="truncate text-xs text-[#B8C4D0]">{replyTo.text}</p>
          </div>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#7E90A3] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFilesSelected}
        className="hidden"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFilesSelected}
        className="hidden"
      />
      <input
        ref={documentInputRef}
        type="file"
        onChange={handleDocumentSelected}
        className="hidden"
      />

      {/* GIPHY Picker Modal */}
      {showGiphy && (
        <div className="mb-2">
          <GiphyPicker
            onSelect={(g) => handleSendMessage({ gifUrl: g.url, gifW: g.width, gifH: g.height }, 'gif')}
            onClose={() => setShowGiphy(false)}
            disabled={isSending}
          />
        </div>
      )}

      {/* Attachment Tray Popover */}
      {showTray && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl bg-[#242F3D] p-3 shadow-xl animate-in fade-in zoom-in-95 duration-150">
          <button
            type="button"
            onClick={handleOpenPhotoPicker}
            className="flex flex-col items-center gap-1 text-[#5288C1] hover:text-white transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#17212B]">
              <ImageIcon className="h-5 w-5" />
            </div>
            <span className="text-[10px]">Photo</span>
          </button>

          <button
            type="button"
            onClick={handleOpenCameraPicker}
            className="flex flex-col items-center gap-1 text-[#5288C1] hover:text-white transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#17212B]">
              <Camera className="h-5 w-5" />
            </div>
            <span className="text-[10px]">Camera</span>
          </button>

          <button
            type="button"
            onClick={handleOpenDocumentPicker}
            className="flex flex-col items-center gap-1 text-[#5288C1] hover:text-white transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#17212B]">
              <FileText className="h-5 w-5" />
            </div>
            <span className="text-[10px]">Files</span>
          </button>

          <button
            type="button"
            onClick={handleOpenGiphyPicker}
            className="flex flex-col items-center gap-1 text-[#5288C1] hover:text-white transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#17212B]">
              <Smile className="h-5 w-5" />
            </div>
            <span className="text-[10px]">GIF</span>
          </button>
        </div>
      )}

      {/* Input Bar (No <form> tag to prevent Android Chrome Autofill Password/Card Toolbar) */}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onPointerDown={(e) => {
            // Prevent textarea from losing focus so virtual keyboard stays open
            e.preventDefault();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            setShowTray((prev) => !prev);
            // Ensure focus is kept on textarea
            if (isFocused) {
              textareaRef.current?.focus({ preventScroll: true });
            }
          }}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
            showTray ? 'bg-[#5288C1] text-white rotate-45' : 'bg-[#242F3D] text-[#7E90A3] hover:text-white'
          }`}
          aria-label="Attach media"
        >
          <Plus className="h-5 w-5 transition-transform" />
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder="Message..."
          rows={1}
          readOnly={isSending}
          autoComplete="off"
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck={true}
          enterKeyHint="send"
          style={{ minHeight: '40px' }}
          className="flex-1 resize-none rounded-2xl bg-[#242F3D] px-4 py-[9px] text-base text-white placeholder-[#7E90A3] outline-none border-0 focus:outline-none focus:ring-0 focus:border-0 max-h-32 leading-snug"
        />

        <button
          type="button"
          disabled={!text.trim() || isSending}
          onPointerDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            if (text.trim() && !isSending) {
              handleSendMessage({ text: text.trim() });
            }
          }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#5288C1] text-white transition hover:bg-[#4372a3] disabled:opacity-40"
        >
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
