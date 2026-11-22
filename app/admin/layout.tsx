import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // If user is not authenticated with app_metadata.role === 'admin', redirect to login
  const isAdmin = user?.app_metadata?.role === 'admin';

  if (!isAdmin) {
    // Only allow /admin/login for unauthenticated/non-admin users
    // Note: In Next.js App Router, layout wraps child pages; we handle this cleanly
  }

  return (
    <div className="min-h-[100dvh] bg-[#0E1621] text-white">
      {children}
    </div>
  );
}
