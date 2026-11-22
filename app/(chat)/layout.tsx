import { AuthProvider } from '@/components/auth/AuthProvider';
import { BottomNavBar } from '@/components/navigation/BottomNavBar';

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <div className="flex min-h-[100dvh] flex-col bg-[#0E1621] text-white">
        <main className="flex-1 min-h-0 flex flex-col">{children}</main>
        <BottomNavBar />
      </div>
    </AuthProvider>
  );
}
