'use client';

import Link from 'next/link';
import { ArrowLeft, Lock, ShieldCheck } from 'lucide-react';

interface ChatHeaderProps {
  roomName: string;
  onLockClick: () => void;
  onOpenSettings: () => void;
}

export function ChatHeader({ roomName, onLockClick, onOpenSettings }: ChatHeaderProps) {
  const initial = roomName.trim().charAt(0).toUpperCase() || 'R';

  return (
    <header className="shrink-0 z-30 flex h-14 w-full items-center justify-between border-b border-[#242F3D] bg-[#17212B] px-3">
      {/* Left Back Arrow */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <Link
          href="/rooms"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-[#7E90A3] hover:text-white transition"
          title="Back to Rooms"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>

        {/* Clickable Header for Telegram-style Room Info / Settings */}
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-2.5 min-w-0 text-left py-1 px-1.5 rounded-xl hover:bg-[#242F3D]/60 transition"
          title="Open Room Info & Settings"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#242F3D] text-sm font-semibold text-[#5288C1]">
            {initial}
          </div>

          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-white">{roomName}</h2>
            <div className="flex items-center gap-1 text-[11px] text-[#4ADE80]">
              <ShieldCheck className="h-3 w-3" />
              <span>End-to-End Encrypted</span>
            </div>
          </div>
        </button>
      </div>

      {/* Right Action Icons: Lock */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onLockClick}
          title="Lock Chat Room Now"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#242F3D] text-[#7E90A3] transition hover:bg-[#2e3b4b] hover:text-amber-400"
        >
          <Lock className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

