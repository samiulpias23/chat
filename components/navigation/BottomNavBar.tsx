'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageSquare, User } from 'lucide-react';

export function BottomNavBar({ forceShow = false }: { forceShow?: boolean } = {}) {
  const pathname = usePathname();

  // Hide bottom navigation when inside a full-screen chat room, unless forceShow is true (e.g. room lock screen)
  if (pathname.startsWith('/chat/') && !forceShow) {
    return null;
  }

  const navItems = [
    { label: 'Rooms', href: '/rooms', icon: MessageSquare },
    { label: 'Profile', href: '/profile', icon: User },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-center justify-around border-t border-[#242F3D] bg-[#17212B] px-4">
      {navItems.map((item) => {
        const isActive = pathname === item.href;
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-col items-center gap-1 transition ${
              isActive ? 'text-[#5288C1]' : 'text-[#7E90A3] hover:text-white'
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[11px] font-medium">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
