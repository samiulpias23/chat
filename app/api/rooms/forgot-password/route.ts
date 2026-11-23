import { NextResponse } from 'next/server';
import { createClient as createAnonClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

// Emails a one-time code to the room owner's account email. The address is never returned in full.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const roomId = typeof body?.roomId === 'string' ? body.roomId : '';
  if (!UUID_RE.test(roomId)) return NextResponse.json({ error: 'Invalid room' }, { status: 400 });

  const admin = createAdminClient();
  const { data: room } = await admin
    .from('rooms')
    .select('owner_id')
    .eq('id', roomId)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

  const { data: owner } = await admin.auth.admin.getUserById(room.owner_id);
  const email = owner?.user?.email;
  if (!email) {
    return NextResponse.json({ error: 'The room owner has no email on file.' }, { status: 409 });
  }

  const mailer = createAnonClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { error } = await mailer.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) {
    const limited = error.status === 429 || /rate|seconds/i.test(error.message);
    return NextResponse.json(
      { error: limited ? 'A code was just sent. Wait a minute before requesting another.' : 'Could not send the code. Try again later.' },
      { status: limited ? 429 : 502 }
    );
  }

  return NextResponse.json({ maskedEmail: maskEmail(email) });
}
