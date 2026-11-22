import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST() {
  try {
    const supabaseAdmin = createAdminClient();
    const guestId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const guestEmail = `guest_${guestId}@guest.chataf.internal`;
    const guestPassword = `GuestPass_${crypto.randomUUID()}`;

    // 1. Create auto-confirmed guest user via service role
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: guestEmail,
      password: guestPassword,
      email_confirm: true,
      user_metadata: { is_guest: true },
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // 2. Create default guest profile
    const displayName = `User_${guestId.slice(0, 4).toUpperCase()}`;
    await supabaseAdmin.from('profiles').upsert({
      id: data.user.id,
      display_name: displayName,
    });

    return NextResponse.json({
      success: true,
      email: guestEmail,
      password: guestPassword,
      user: data.user,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Guest session initialization failed.' }, { status: 500 });
  }
}
