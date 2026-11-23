'use client';

import { useState } from 'react';
import { FileText, Download, Check, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { decryptMediaBlob } from '@/lib/crypto';
import { getCachedCiphertext, setCachedCiphertext } from '@/lib/cipherCache';

interface FileAttachmentCardProps {
  roomId: string;
  messageId: string;
  fileName: string;
  rmk: CryptoKey;
  isOutgoing: boolean;
}

export function FileAttachmentCard({
  roomId,
  messageId,
  fileName,
  rmk,
  isOutgoing,
}: FileAttachmentCardProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownloadFile = async () => {
    if (isDownloading) return;
    setIsDownloading(true);

    try {
      const slot = 'raw-0';
      const path = `${roomId}/${messageId}/${slot}.enc`;
      const supabase = createClient();

      let cipherBuffer = await getCachedCiphertext(path);

      if (!cipherBuffer) {
        const { data: blob, error } = await supabase.storage.from('chat-media').download(path);
        if (error || !blob) throw new Error('File not found or expired.');
        cipherBuffer = await blob.arrayBuffer();
        await setCachedCiphertext(path, cipherBuffer);
      }

      // Decrypt raw original file bytes using RMK
      const decryptedBuffer = await decryptMediaBlob(rmk, roomId, messageId, slot, cipherBuffer);

      // Create downloadable file with original decrypted filename
      const fileBlob = new Blob([decryptedBuffer]);
      const fileUrl = URL.createObjectURL(fileBlob);

      const a = document.createElement('a');
      a.href = fileUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(fileUrl), 5000);
      setIsDone(true);
      setTimeout(() => setIsDone(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to download and decrypt file.');
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div
      onClick={handleDownloadFile}
      className={`flex items-center gap-3 rounded-xl p-2.5 cursor-pointer transition select-none ${
        isOutgoing ? 'bg-black/20 hover:bg-black/30' : 'bg-black/30 hover:bg-black/40'
      }`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#5288C1] text-white">
        {isDownloading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : isDone ? (
          <Check className="h-5 w-5 text-[#4ADE80]" />
        ) : (
          <FileText className="h-5 w-5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-white">{fileName}</p>
        {error ? (
          <p role="alert" className="text-[10px] text-red-300">{error}</p>
        ) : (
          <p className="text-[10px] text-[#7E90A3]">Encrypted Document · Tap to download</p>
        )}
      </div>

      <div className="shrink-0 p-1 text-[#5288C1] hover:text-white">
        <Download className="h-4 w-4" />
      </div>
    </div>
  );
}
