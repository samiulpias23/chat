'use client';

import { useState } from 'react';
import { X, Download, Check, Trash2, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { decryptMediaBlob } from '@/lib/crypto';
import { getCachedCiphertext, setCachedCiphertext } from '@/lib/cipherCache';

interface RawGalleryModalProps {
  roomId: string;
  messageId: string;
  initialIndex?: number;
  totalImages: number;
  rmk: CryptoKey;
  mediaDeleted: boolean;
  onClose: () => void;
  onMediaDeletedServer?: () => void;
}

export function RawGalleryModal({
  roomId,
  messageId,
  initialIndex = 0,
  totalImages,
  rmk,
  mediaDeleted,
  onClose,
  onMediaDeletedServer,
}: RawGalleryModalProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedIndices, setDownloadedIndices] = useState<Set<number>>(new Set());
  const [rawObjectUrls, setRawObjectUrls] = useState<Record<number, string>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Fetch, decrypt, save raw image to device and cache in IndexedDB
  const downloadRawImage = async (index: number) => {
    if (isDownloading || downloadedIndices.has(index)) return;
    setIsDownloading(true);

    try {
      const slot = `raw-${index}`;
      const path = `${roomId}/${messageId}/${slot}.enc`;
      const supabase = createClient();

      let cipherBuffer = await getCachedCiphertext(path);

      if (!cipherBuffer) {
        // Download from Supabase Storage directly
        const { data: blob, error } = await supabase.storage.from('chat-media').download(path);
        if (error || !blob) throw new Error('Could not download raw image from server.');
        cipherBuffer = await blob.arrayBuffer();
        await setCachedCiphertext(path, cipherBuffer);
      }

      // Decrypt raw original bytes
      const decryptedBuffer = await decryptMediaBlob(rmk, roomId, messageId, slot, cipherBuffer);

      // Create downloadable file
      const fileBlob = new Blob([decryptedBuffer], { type: 'image/jpeg' });
      const fileUrl = URL.createObjectURL(fileBlob);

      setRawObjectUrls((prev) => ({ ...prev, [index]: fileUrl }));
      setDownloadedIndices((prev) => new Set(prev).add(index));

      // Trigger native device download
      const a = document.createElement('a');
      a.href = fileUrl;
      a.download = `ChatAf_Photo_${messageId.slice(0, 6)}_${index + 1}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: any) {
      alert(err.message || 'Download failed.');
    } finally {
      setIsDownloading(false);
    }
  };

  // Delete from Server flow (Download-to-Delete)
  const handleDeleteFromServer = async () => {
    setIsDeleting(true);
    try {
      const supabase = createClient();

      // Step 1: Flag message as media_deleted via RPC
      const { error: rpcErr } = await supabase.rpc('delete_message_media', {
        p_message_id: messageId,
      });

      if (rpcErr) throw rpcErr;

      // Step 2: Remove blobs from Supabase Storage
      const pathsToDelete: string[] = [];
      for (let i = 0; i < totalImages; i++) {
        pathsToDelete.push(`${roomId}/${messageId}/raw-${i}.enc`);
        pathsToDelete.push(`${roomId}/${messageId}/thumb-${i}.enc`);
      }

      await supabase.storage.from('chat-media').remove(pathsToDelete);

      onMediaDeletedServer?.();
      setShowDeleteConfirm(false);
    } catch (err: any) {
      alert(err.message || 'Failed to delete media from server.');
    } finally {
      setIsDeleting(false);
    }
  };

  const isCurrentDownloaded = downloadedIndices.has(currentIndex);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white backdrop-blur-sm">
      {/* Top Bar */}
      <div className="flex h-14 items-center justify-between px-4">
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>

        <span className="text-xs text-white/70">
          {currentIndex + 1} of {totalImages}
        </span>

        <div className="flex items-center gap-2">
          {isCurrentDownloaded && !mediaDeleted && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete from Server"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-red-950/60 text-red-400 hover:bg-red-900/60"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          <button
            onClick={() => downloadRawImage(currentIndex)}
            disabled={isDownloading || isCurrentDownloaded}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              isCurrentDownloaded
                ? 'bg-[#4ADE80]/20 text-[#4ADE80]'
                : 'bg-[#5288C1] text-white hover:bg-[#4372a3]'
            }`}
          >
            {isDownloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isCurrentDownloaded ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Downloaded
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                Save Raw
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Image View */}
      <div className="relative flex flex-1 items-center justify-center p-2">
        {rawObjectUrls[currentIndex] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={rawObjectUrls[currentIndex]}
            alt={`Raw Photo ${currentIndex + 1}`}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-center">
            <p className="text-sm font-medium text-white/80">Tap &apos;Save Raw&apos; to download and view 4K original</p>
            <p className="mt-1 text-xs text-white/50">Lossless encrypted bytes direct from storage</p>
          </div>
        )}

        {/* Carousel Navigation */}
        {totalImages > 1 && (
          <>
            <button
              onClick={() => setCurrentIndex((prev) => (prev > 0 ? prev - 1 : totalImages - 1))}
              className="absolute left-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              onClick={() => setCurrentIndex((prev) => (prev < totalImages - 1 ? prev + 1 : 0))}
              className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212B] p-5 border border-[#242F3D] text-center">
            <Trash2 className="mx-auto h-8 w-8 text-red-400" />
            <h3 className="mt-3 text-base font-semibold text-white">Delete media from server?</h3>
            <p className="mt-2 text-xs text-[#7E90A3] leading-relaxed">
              Because you have downloaded this photo to your device, it will stay in your local cache, but will be permanently removed from Supabase storage for all other members.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 rounded-xl bg-[#242F3D] py-2.5 text-xs font-medium text-white hover:bg-[#2b3745]"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteFromServer}
                disabled={isDeleting}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
