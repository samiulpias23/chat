import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }

    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }

    const supabaseAdmin = createAdminClient();
    const cleanEmail = email.trim().toLowerCase();

    // 1. Try creating the user with auto-confirmation enabled
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: cleanEmail,
      password,
      email_confirm: true,
    });

    if (error) {
      // If user was previously created but unconfirmed, auto-confirm and update password
      if (error.message?.includes('already') || error.message?.includes('unique') || error.message?.includes('exists')) {
        const { data: userList } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = userList?.users?.find((u) => u.email?.toLowerCase() === cleanEmail);

        if (existingUser) {
          await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
            password,
            email_confirm: true,
          });
          return NextResponse.json({ success: true, user: existingUser });
        }

        return NextResponse.json(
          { error: 'An account with this email already exists. Please sign in.' },
          { status: 400 }
        );
      }

      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, user: data.user });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Registration failed.' }, { status: 500 });
  }
}
