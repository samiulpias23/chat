'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Plus, ShieldCheck, Loader2, MessageSquare } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { RoomSearchBar } from '@/components/rooms/RoomSearchBar';
import { RoomCard, RoomItem } from '@/components/rooms/RoomCard';

export default function RoomsPage() {
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchRooms() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from('rooms')
          .select('id, name, status, expires_at, created_at')
          .eq('status', 'active')
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false });

        if (!error && data) {
          setRooms(data as RoomItem[]);
        }
      } catch (err) {
        console.error('Failed to fetch rooms:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchRooms();
  }, []);

  // Real-time client-side substring search
  const filteredRooms = rooms.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col px-4 pt-4 pb-24">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5288C1] text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-white">ChatAf</h1>
        </div>

        <Link
          href="/rooms/new"
          className="flex items-center gap-1.5 rounded-lg bg-[#242F3D] px-3 py-1.5 text-xs font-medium text-[#5288C1] transition hover:bg-[#2b3745] hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" />
          Create Room
        </Link>
      </div>

      {/* Room Search Bar */}
      <div className="my-2">
        <RoomSearchBar value={searchQuery} onChange={setSearchQuery} />
      </div>

      {/* Room Directory List */}
      <div className="mt-2 space-y-2">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-[#7E90A3]">
            <Loader2 className="h-6 w-6 animate-spin text-[#5288C1]" />
            <p className="mt-2 text-xs">Loading rooms...</p>
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl bg-[#17212B] p-8 text-center border border-[#242F3D]">
            <MessageSquare className="h-8 w-8 text-[#7E90A3]" />
            <p className="mt-2 text-sm font-medium text-white">No rooms found</p>
            <p className="mt-1 text-xs text-[#7E90A3]">
              {searchQuery ? 'Try a different search term.' : 'Be the first to create a secure room!'}
            </p>
          </div>
        ) : (
          filteredRooms.map((room) => <RoomCard key={room.id} room={room} />)
        )}
      </div>
    </div>
  );
}
