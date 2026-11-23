'use client';

import { useState, useEffect } from 'react';
import { Download, Check, Loader2, Image as ImageIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { decryptMediaBlob } from '@/lib/crypto';
import { getCachedCiphertext, setCachedCiphertext } from '@/lib/cipherCache';
import { objectUrlRegistry } from '@/lib/urlRegistry';

interface MultiImageMosaicProps {
  roomId: string;
  messageId: string;
  mediaCount: number;
  mediaDeleted: boolean;
  rmk: CryptoKey;
  lockGeneration: number;
  onOpenImage?: (messageId: string, index: number) => void;
}

export function MultiImageMosaic({
  roomId,
  messageId,
  mediaCount,
  mediaDeleted,
  rmk,
  lockGeneration,
  onOpenImage,
}: MultiImageMosaicProps) {
  const [thumbUrls, setThumbUrls] = useState<Record<number, string>>({});
  const [downloadedSet, setDownloadedSet] = useState<Set<number>>(new Set());
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch and decrypt 160px thumbnails (<15KB) with zero egress on subsequent unlocks
  useEffect(() => {
    let isCancelled = false;
    const created: string[] = [];

    async function loadThumbnails() {
      if (mediaDeleted) return;

      const supabase = createClient();
      const urls: Record<number, string> = {};

      for (let i = 0; i < mediaCount; i++) {
        if (isCancelled) break;
        const slot = `thumb-${i}`;
        const path = `${roomId}/${messageId}/${slot}.enc`;

        try {
          let cipherBuffer = await getCachedCiphertext(path);

          if (!cipherBuffer) {
            const { data: blob, error } = await supabase.storage.from('chat-media').download(path);
            if (!error && blob) {
              cipherBuffer = await blob.arrayBuffer();
              await setCachedCiphertext(path, cipherBuffer);
            }
          }

          if (cipherBuffer && !isCancelled) {
            const decryptedBuffer = await decryptMediaBlob(rmk, roomId, messageId, slot, cipherBuffer);
            const thumbBlob = new Blob([decryptedBuffer], { type: 'image/webp' });
            urls[i] = objectUrlRegistry.create(thumbBlob);
            created.push(urls[i]);
          }
        } catch (err) {
          console.warn(`Failed to decrypt thumbnail ${i}:`, err);
        }
      }

      if (!isCancelled) {
        setThumbUrls(urls);
      }
    }

    loadThumbnails();

    return () => {
      isCancelled = true;
      created.forEach((u) => objectUrlRegistry.revoke(u));
    };
  }, [roomId, messageId, mediaCount, mediaDeleted, rmk, lockGeneration]);

  // Batch "Download All" handler
  const handleDownloadAll = async () => {
    if (isBatchDownloading || mediaDeleted) return;
    setIsBatchDownloading(true);

    try {
      const supabase = createClient();

      for (let i = 0; i < mediaCount; i++) {
        const slot = `raw-${i}`;
        const path = `${roomId}/${messageId}/${slot}.enc`;

        let cipherBuffer = await getCachedCiphertext(path);
        if (!cipherBuffer) {
          const { data: blob } = await supabase.storage.from('chat-media').download(path);
          if (blob) {
            cipherBuffer = await blob.arrayBuffer();
            await setCachedCiphertext(path, cipherBuffer);
          }
        }

        if (cipherBuffer) {
          const decrypted = await decryptMediaBlob(rmk, roomId, messageId, slot, cipherBuffer);
          const fileBlob = new Blob([decrypted], { type: 'image/jpeg' });
          const fileUrl = URL.createObjectURL(fileBlob);

          const a = document.createElement('a');
          a.href = fileUrl;
          a.download = `ChatAf_${messageId.slice(0, 6)}_${i + 1}.jpg`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          setDownloadedSet((prev) => new Set(prev).add(i));
        }
      }
    } catch (err: any) {
      setError(err.message || 'Batch download failed.');
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsBatchDownloading(false);
    }
  };

  if (mediaDeleted) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-black/30 p-3 text-xs text-[#7E90A3] italic">
        <ImageIcon className="h-4 w-4" />
        <span>Media deleted from server</span>
      </div>
    );
  }

  const allDownloaded = downloadedSet.size === mediaCount && mediaCount > 0;

  return (
    <div className="space-y-2">
      {/* Batch Download Header */}
      {mediaCount > 1 && (
        <div className="flex items-center justify-between pb-1">
          <span className="text-[11px] font-medium text-[#7E90A3]">
            {mediaCount} Raw Photos
          </span>
          <button
            onClick={handleDownloadAll}
            disabled={isBatchDownloading || allDownloaded}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
              allDownloaded
                ? 'bg-[#4ADE80]/20 text-[#4ADE80]'
                : 'bg-[#5288C1]/30 text-white hover:bg-[#5288C1]/50'
            }`}
          >
            {isBatchDownloading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Downloading...
              </>
            ) : allDownloaded ? (
              <>
                <Check className="h-3 w-3" />
                All Saved
              </>
            ) : (
              <>
                <Download className="h-3 w-3" />
                Download All ({mediaCount})
              </>
            )}
          </button>
        </div>
      )}

      {/* Grid Mosaic */}
      <div
        style={{ width: 'min(66vw, 260px)' }}
        className={`grid gap-1 overflow-hidden rounded-xl ${
          mediaCount === 1 ? 'grid-cols-1' : mediaCount === 2 || mediaCount === 4 ? 'grid-cols-2' : 'grid-cols-3'
        }`}
      >
        {Array.from({ length: mediaCount }).map((_, idx) => (
          <button
            type="button"
            key={idx}
            onClick={() => onOpenImage?.(messageId, idx)}
            aria-label={`Open photo ${idx + 1} of ${mediaCount}`}
            className={`group relative cursor-pointer overflow-hidden bg-[#0E1621] ${
              mediaCount === 1 ? 'aspect-[4/3]' : 'aspect-square'
            }`}
          >
            {thumbUrls[idx] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbUrls[idx]}
                alt={`Photo ${idx + 1}`}
                className="h-full w-full object-cover transition group-hover:scale-105"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-[#5288C1]" />
              </div>
            )}

            {/* Individual download indicator */}
            {downloadedSet.has(idx) && (
              <span className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#4ADE80] text-black">
                <Check className="h-3 w-3" />
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-[11px] text-red-300">{error}</p>
      )}
    </div>
  );
}
