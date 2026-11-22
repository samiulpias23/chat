'use client';

import { useState, useEffect } from 'react';
import { Search, Loader2, X } from 'lucide-react';

interface GiphyPickerProps {
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

export function GiphyPicker({ onSelect, onClose }: GiphyPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isCancelled = false;

    async function loadGifs() {
      setIsLoading(true);
      try {
        const url = query.trim()
          ? `/api/gif/search?q=${encodeURIComponent(query.trim())}`
          : '/api/gif/search';
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (!isCancelled && data?.data) {
            setGifs(data.data);
          }
        }
      } catch (err) {
        console.warn('Failed to load GIFs:', err);
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    }

    const timer = setTimeout(loadGifs, 350);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="flex h-72 flex-col rounded-2xl bg-[#17212B] p-3 shadow-2xl border border-[#242F3D]">
      {/* Header & Search */}
      <div className="flex items-center gap-2 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[#7E90A3]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIPHY..."
            className="w-full rounded-xl bg-[#242F3D] py-1.5 pl-8 pr-3 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
          />
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[#7E90A3] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* GIF Grid */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-[#5288C1]" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {gifs.map((g) => {
              const url = g.images?.fixed_height?.url || g.images?.original?.url;
              if (!url) return null;
              return (
                <div
                  key={g.id}
                  onClick={() => onSelect(url)}
                  className="aspect-video cursor-pointer overflow-hidden rounded-lg bg-[#0E1621] transition hover:opacity-80"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={g.title} className="h-full w-full object-cover" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
