'use client';

import { getSenderColor } from '@/lib/senderColor';

interface PresenceDockProps {
  online: string[];
  typing: string[];
  names: Record<string, string>;
}

const MAX_HEADS = 6;

// Snapchat-style heads peeking over the top edge of the composer. A member who is typing gets a floating dots bubble.
export function PresenceDock({ online, typing, names }: PresenceDockProps) {
  if (online.length === 0) return null;

  // Anyone typing is always shown, then fill with the rest
  const ordered = [...online].sort((a, b) => Number(typing.includes(b)) - Number(typing.includes(a)));
  const shown = ordered.slice(0, MAX_HEADS).sort((a, b) => online.indexOf(a) - online.indexOf(b));
  const extra = online.length - shown.length;

  return (
    <div
      aria-live="polite"
      style={{ bottom: 'calc(100% - 7px)' }}
      className="pointer-events-none absolute left-3 z-10 flex items-end gap-1.5"
    >
      {shown.map((id) => {
        const name = names[id] || 'Member';
        const isTyping = typing.includes(id);
        return (
          <div key={id} className="relative" title={isTyping ? `${name} is typing` : `${name} is here`}>
            {isTyping && (
              <span
                role="status"
                aria-label={`${name} is typing`}
                className="absolute bottom-full left-1/2 mb-1 flex -translate-x-1/2 items-center gap-[3px] rounded-full bg-[#2B5278] px-2.5 py-2 shadow-md"
              >
                <i className="typing-dot block h-1.5 w-1.5 rounded-full bg-white" />
                <i className="typing-dot block h-1.5 w-1.5 rounded-full bg-white" />
                <i className="typing-dot block h-1.5 w-1.5 rounded-full bg-white" />
              </span>
            )}
            <span
              style={{ backgroundColor: getSenderColor(id) }}
              className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold uppercase text-[#0E1621] ring-2 ring-[#17212B]"
            >
              {name.trim().charAt(0) || '?'}
            </span>
          </div>
        );
      })}
      {extra > 0 && (
        <span className="flex h-8 min-w-8 items-center justify-center rounded-full bg-[#242F3D] px-1.5 text-[11px] font-semibold text-[#7E90A3] ring-2 ring-[#17212B]">
          +{extra}
        </span>
      )}
    </div>
  );
}
