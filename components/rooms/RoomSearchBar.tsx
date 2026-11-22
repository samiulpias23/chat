'use client';

import { Search, X } from 'lucide-react';

interface RoomSearchBarProps {
  value: string;
  onChange: (query: string) => void;
}

export function RoomSearchBar({ value, onChange }: RoomSearchBarProps) {
  return (
    <div className="relative w-full">
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[#7E90A3]">
        <Search className="h-4 w-4" />
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search rooms..."
        className="w-full rounded-xl bg-[#242F3D] py-2.5 pl-9 pr-9 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#7E90A3] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
