'use client';

import { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, X, ImageOff } from 'lucide-react';

export interface PickedGif {
  url: string;
  width: number;
  height: number;
}

interface GiphyPickerProps {
  onSelect: (gif: PickedGif) => void;
  onClose: () => void;
  disabled?: boolean;
}

interface GiphyItem {
  id: string;
  title: string;
  preview: PickedGif;
  send: PickedGif;
}

function toGif(img: any): PickedGif | null {
  if (!img?.url) return null;
  return { url: img.url, width: Number(img.width) || 200, height: Number(img.height) || 200 };
}

function parseItems(data: any[]): GiphyItem[] {
  const items: GiphyItem[] = [];
  for (const g of data) {
    const preview = toGif(g.images?.fixed_width_small) ?? toGif(g.images?.fixed_width);
    const send = toGif(g.images?.downsized) ?? toGif(g.images?.fixed_height) ?? preview;
    if (preview && send) items.push({ id: g.id, title: g.title || 'GIF', preview, send });
  }
  return items;
}

export function GiphyPicker({ onSelect, onClose, disabled = false }: GiphyPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GiphyItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();

    async function loadGifs() {
      setIsLoading(true);
      setFailed(false);
      try {
        const q = query.trim();
        const res = await fetch(q ? `/api/gif/search?q=${encodeURIComponent(q)}` : '/api/gif/search', {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('GIF search failed');
        const data = await res.json();
        if (!isCancelled) setGifs(parseItems(data?.data ?? []));
      } catch (err) {
        if (!isCancelled && (err as Error).name !== 'AbortError') setFailed(true);
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    }

    const timer = setTimeout(loadGifs, query ? 350 : 0);
    return () => {
      isCancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  // Balance two masonry columns by rendered height so tiles keep their real aspect ratio.
  const columns = useMemo(() => {
    const cols: GiphyItem[][] = [[], []];
    const heights = [0, 0];
    for (const g of gifs) {
      const i = heights[0] <= heights[1] ? 0 : 1;
      cols[i].push(g);
      heights[i] += g.preview.height / g.preview.width;
    }
    return cols;
  }, [gifs]);

  return (
    <div className="flex h-[min(20rem,45dvh)] flex-col overflow-hidden rounded-2xl border border-[#242F3D] bg-[#17212B] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-[#242F3D]/70 p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7E90A3]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIFs"
            aria-label="Search GIFs"
            enterKeyHint="search"
            className="h-9 w-full rounded-xl bg-[#242F3D] pl-9 pr-3 text-base text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close GIF picker"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[#7E90A3] transition hover:bg-[#242F3D] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex-1 overflow-y-auto overscroll-contain p-2">
        {isLoading && gifs.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-[#5288C1]" />
          </div>
        ) : failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-[#7E90A3]">
            <ImageOff className="h-5 w-5" />
            <span>Couldn&apos;t load GIFs. Check your connection.</span>
          </div>
        ) : gifs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-[#7E90A3]">
            No GIFs found for &ldquo;{query.trim()}&rdquo;
          </div>
        ) : (
          <div className={`flex gap-1.5 transition-opacity ${isLoading ? 'opacity-50' : ''}`}>
            {columns.map((col, ci) => (
              <div key={ci} className="flex min-w-0 flex-1 flex-col gap-1.5">
                {col.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onSelect(g.send)}
                    aria-label={g.title}
                    style={{ aspectRatio: `${g.preview.width} / ${g.preview.height}` }}
                    className="w-full overflow-hidden rounded-lg bg-[#0E1621] transition active:scale-95 disabled:opacity-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={g.preview.url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="border-t border-[#242F3D]/70 py-1 text-center text-[10px] text-[#7E90A3]">Powered by GIPHY</p>
    </div>
  );
}
