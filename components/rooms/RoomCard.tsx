'use client';

import Link from 'next/link';
import { Lock, ShieldCheck, Clock } from 'lucide-react';

export interface RoomItem {
  id: string;
  name: string;
  status: 'pending_payment' | 'unlocked_setup' | 'active' | 'expired';
  expires_at: string | null;
  created_at: string;
}

interface RoomCardProps {
  room: RoomItem;
}

export function RoomCard({ room }: RoomCardProps) {
  const isExpired = room.expires_at ? new Date(room.expires_at).getTime() <= Date.now() : false;
  const isLive = room.status === 'active' && !isExpired;

  // Initial letter circle for avatar
  const initial = room.name.trim().charAt(0).toUpperCase() || 'R';

  return (
    <Link
      href={`/chat/${room.id}`}
      className="flex items-center gap-3.5 rounded-xl bg-[#17212B] p-3 transition hover:bg-[#1f2b38] border border-transparent hover:border-[#242F3D]"
    >
      <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#242F3D] text-base font-semibold text-[#5288C1]">
        {initial}
        {isLive && (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-[#17212B] bg-[#4ADE80]" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <h3 className="truncate text-sm font-medium text-white">{room.name}</h3>
          {isLive ? (
            <span className="flex items-center gap-1 text-[11px] text-[#4ADE80]">
              <ShieldCheck className="h-3 w-3" />
              Active
            </span>
          ) : isExpired ? (
            <span className="flex items-center gap-1 text-[11px] text-red-400">
              <Clock className="h-3 w-3" />
              Expired
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-amber-400">
              <Lock className="h-3 w-3" />
              {room.status === 'pending_payment' ? 'Locked' : 'Setup'}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-[#7E90A3]">
          End-to-End Encrypted Room
        </p>
      </div>
    </Link>
  );
}
