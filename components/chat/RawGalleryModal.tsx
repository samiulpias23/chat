'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, Check, Trash2, Loader2, ChevronLeft, ChevronRight, ImageDown } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { decryptMediaBlob } from '@/lib/crypto';
import { getCachedCiphertext, setCachedCiphertext } from '@/lib/cipherCache';
import { objectUrlRegistry } from '@/lib/urlRegistry';

export interface GalleryItem {
  messageId: string;
  index: number; // photo index inside its message
  count: number; // photos in that message
}

interface RawGalleryModalProps {
  roomId: string;
  items: GalleryItem[]; // every live photo in the room, oldest first
  startMessageId: string;
  startIndex: number;
  rmk: CryptoKey;
  onClose: () => void;
}

const keyOf = (it: GalleryItem) => `${it.messageId}:${it.index}`;
const SWIPE_PX = 60;

async function loadDecrypted(
  roomId: string,
  it: GalleryItem,
  kind: 'thumb' | 'raw',
  rmk: CryptoKey,
  cacheOnly = false
): Promise<ArrayBuffer | null> {
  const slot = `${kind}-${it.index}`;
  const path = `${roomId}/${it.messageId}/${slot}.enc`;
  let cipher = await getCachedCiphertext(path);
  if (!cipher) {
    if (cacheOnly) return null;
    const { data: blob, error } = await createClient().storage.from('chat-media').download(path);
    if (error || !blob) throw new Error(`Could not load the ${kind === 'raw' ? 'full-quality photo' : 'preview'}.`);
    cipher = await blob.arrayBuffer();
    await setCachedCiphertext(path, cipher);
  }
  return decryptMediaBlob(rmk, roomId, it.messageId, slot, cipher);
}

interface SlideProps {
  roomId: string;
  item: GalleryItem;
  rmk: CryptoKey;
  rawUrl?: string;
  isRawLoading: boolean;
  onLoadRaw: (it: GalleryItem) => void;
  onCachedRaw: (it: GalleryItem, url: string) => void;
  isCurrent: boolean;
}

function GallerySlide({ roomId, item, rmk, rawUrl, isRawLoading, onLoadRaw, onCachedRaw, isCurrent }: SlideProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const { messageId, index } = item;

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    loadDecrypted(roomId, { messageId, index, count: 0 }, 'thumb', rmk)
      .then((buf) => {
        if (cancelled || !buf) return;
        url = objectUrlRegistry.create(new Blob([buf], { type: 'image/webp' }));
        setThumbUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) objectUrlRegistry.revoke(url);
    };
  }, [roomId, messageId, index, rmk]);

  // A full-quality copy already sitting in the ciphertext cache costs no egress, so show it straight away.
  useEffect(() => {
    if (!isCurrent || rawUrl) return;
    let cancelled = false;
    const it = { messageId, index, count: 0 };
    loadDecrypted(roomId, it, 'raw', rmk, true)
      .then((buf) => {
        if (cancelled || !buf) return;
        onCachedRaw(it, objectUrlRegistry.create(new Blob([buf])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isCurrent, rawUrl, roomId, messageId, index, rmk, onCachedRaw]);

  const src = rawUrl || thumbUrl;

  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      {src ? (
        <div className="relative flex max-h-full max-w-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={`Photo ${item.index + 1} of ${item.count}`}
            draggable={false}
            className={`max-h-[calc(100dvh-8.5rem)] max-w-full select-none rounded-lg object-contain shadow-2xl ${
              rawUrl ? '' : 'min-h-40 min-w-40'
            }`}
          />
          {!rawUrl && isCurrent && (
            <button
              type="button"
              onClick={() => onLoadRaw(item)}
              disabled={isRawLoading}
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3.5 py-2 text-xs font-medium text-white backdrop-blur disabled:opacity-70"
            >
              {isRawLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageDown className="h-3.5 w-3.5" />}
              {isRawLoading ? 'Loading...' : 'Load full quality'}
            </button>
          )}
        </div>
      ) : (
        <Loader2 className="h-6 w-6 animate-spin text-[#5288C1]" />
      )}
    </div>
  );
}

export function RawGalleryModal({ roomId, items, startMessageId, startIndex, rmk, onClose }: RawGalleryModalProps) {
  const [currentKey, setCurrentKey] = useState(`${startMessageId}:${startIndex}`);
  const lastPos = useRef(0);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef({ x: 0, y: 0, active: false, horizontal: false });

  const [rawUrls, setRawUrls] = useState<Record<string, string>>({});
  const [loadingRaw, setLoadingRaw] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list can shrink while open (media deleted, message expired): fall back to the nearest photo
  let pos = items.findIndex((it) => keyOf(it) === currentKey);
  if (pos === -1) pos = Math.max(0, Math.min(lastPos.current, items.length - 1));
  lastPos.current = pos;
  const current = items[pos];

  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  useEffect(() => {
    if (current && keyOf(current) !== currentKey) setCurrentKey(keyOf(current));
  }, [current, currentKey]);

  // Revoke every raw object URL when the viewer closes
  const rawUrlsRef = useRef(rawUrls);
  rawUrlsRef.current = rawUrls;
  useEffect(() => {
    return () => {
      Object.values(rawUrlsRef.current).forEach((u) => objectUrlRegistry.revoke(u));
    };
  }, []);

  const go = useCallback(
    (delta: number) => {
      const next = items[pos + delta];
      if (next) setCurrentKey(keyOf(next));
    },
    [items, pos]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  const handleCachedRaw = useCallback((it: GalleryItem, url: string) => {
    setRawUrls((prev) => {
      if (prev[keyOf(it)]) {
        objectUrlRegistry.revoke(url);
        return prev;
      }
      return { ...prev, [keyOf(it)]: url };
    });
  }, []);

  const loadRaw = useCallback(
    async (it: GalleryItem): Promise<string | null> => {
      const k = keyOf(it);
      if (rawUrlsRef.current[k]) return rawUrlsRef.current[k];
      setLoadingRaw(k);
      setError(null);
      try {
        const buf = await loadDecrypted(roomId, it, 'raw', rmk);
        if (!buf) return null;
        const url = objectUrlRegistry.create(new Blob([buf]));
        setRawUrls((prev) => ({ ...prev, [k]: url }));
        return url;
      } catch (err: any) {
        setError(err.message || 'Could not load the photo.');
        return null;
      } finally {
        setLoadingRaw((v) => (v === k ? null : v));
      }
    },
    [roomId, rmk]
  );

  const saveToDevice = async () => {
    if (!current) return;
    const k = keyOf(current);
    const url = await loadRaw(current);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `ChatAf_Photo_${current.messageId.slice(0, 6)}_${current.index + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setSaved((prev) => new Set(prev).add(k));
  };

  const handleDeleteFromServer = async () => {
    if (!current) return;
    setIsDeleting(true);
    try {
      const supabase = createClient();
      const { error: rpcErr } = await supabase.rpc('delete_message_media', { p_message_id: current.messageId });
      if (rpcErr) throw rpcErr;

      const paths: string[] = [];
      for (let i = 0; i < current.count; i++) {
        paths.push(`${roomId}/${current.messageId}/raw-${i}.enc`, `${roomId}/${current.messageId}/thumb-${i}.enc`);
      }
      await supabase.storage.from('chat-media').remove(paths);
      // The realtime UPDATE flags the message deleted and removes its photos from `items`
    } catch (err: any) {
      setError(err.message || 'Failed to delete media from server.');
    } finally {
      setShowDeleteConfirm(false);
      setIsDeleting(false);
    }
  };

  // Horizontal swipe with pointer events (touch + mouse); vertical movement is left to the browser
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, active: true, horizontal: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.horizontal) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        d.active = false;
        return;
      }
      d.horizontal = true;
      setIsDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const atStart = pos === 0 && dx > 0;
    const atEnd = pos === items.length - 1 && dx < 0;
    setDragX(atStart || atEnd ? dx / 4 : dx);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    if (d.horizontal) {
      const dx = e.clientX - d.x;
      if (dx <= -SWIPE_PX) go(1);
      else if (dx >= SWIPE_PX) go(-1);
    }
    setIsDragging(false);
    setDragX(0);
  };

  if (!current) return null;

  const k = keyOf(current);
  const isSaved = saved.has(k);
  const visible = [pos - 1, pos, pos + 1].filter((i) => i >= 0 && i < items.length);

  return (
    <div role="dialog" aria-modal="true" aria-label="Photo viewer" className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>

        <span className="text-xs tabular-nums text-white/70">
          {pos + 1} / {items.length}
        </span>

        <div className="flex items-center gap-2">
          {isSaved && (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              aria-label="Delete from server"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-950/60 text-red-400 hover:bg-red-900/60"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={saveToDevice}
            disabled={loadingRaw === k || isSaved}
            className={`flex h-10 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition ${
              isSaved ? 'bg-[#4ADE80]/20 text-[#4ADE80]' : 'bg-[#5288C1] text-white hover:bg-[#4372a3]'
            }`}
          >
            {loadingRaw === k ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isSaved ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Saved
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                Save
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mx-3 rounded-lg bg-red-950/80 px-3 py-2 text-center text-xs text-red-200">
          {error}
        </div>
      )}

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {visible.map((i) => {
          const it = items[i];
          return (
            <div
              key={keyOf(it)}
              className={`absolute inset-0 ${isDragging ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'}`}
              style={{ transform: `translateX(calc(${(i - pos) * 100}% + ${dragX}px))` }}
            >
              <GallerySlide
                roomId={roomId}
                item={it}
                rmk={rmk}
                rawUrl={rawUrls[keyOf(it)]}
                isRawLoading={loadingRaw === keyOf(it)}
                onLoadRaw={loadRaw}
                onCachedRaw={handleCachedRaw}
                isCurrent={i === pos}
              />
            </div>
          );
        })}

        {pos > 0 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 hover:bg-black/80 sm:flex"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {pos < items.length - 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 hover:bg-black/80 sm:flex"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      <div className="h-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0" />

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#242F3D] bg-[#17212B] p-5 text-center">
            <Trash2 className="mx-auto h-8 w-8 text-red-400" />
            <h3 className="mt-3 text-base font-semibold text-white">Delete from server?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[#7E90A3]">
              You saved this photo to your device. Deleting removes {current.count > 1 ? `all ${current.count} photos in this album` : 'it'} from
              storage for every member. Anyone who has not saved {current.count > 1 ? 'them' : 'it'} loses {current.count > 1 ? 'them' : 'it'}.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 rounded-xl bg-[#242F3D] py-2.5 text-xs font-medium text-white hover:bg-[#2b3745]"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={handleDeleteFromServer}
                disabled={isDeleting}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
