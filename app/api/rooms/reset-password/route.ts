import { NextResponse } from 'next/server';
import { createClient as createAnonClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

// Verifies the emailed OTP against the room owner's account, then swaps in a brand-new key wrapping.
// The client generated a NEW room key from the new password; the old one cannot be recovered.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const roomId = str(body?.roomId, 36);
  const otp = str(body?.otp, 10);
  const kdfSalt = str(body?.kdfSalt, 64);
  const wrappedKey = str(body?.wrappedKey, 200);
  const wrappedIv = str(body?.wrappedIv, 32);
  const authToken = str(body?.authToken, 200);
  if (!roomId || !UUID_RE.test(roomId) || !otp || !/^\d{6,10}$/.test(otp) || !kdfSalt || !wrappedKey || !wrappedIv || !authToken) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Guess limiter keyed on the requester + room (never on a client-supplied IP).
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await admin
    .from('room_auth_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .gt('attempted_at', since);
  if ((count ?? 0) >= 5) {
    return NextResponse.json({ error: 'Too many attempts. Wait 10 minutes and request a new code.' }, { status: 429 });
  }

  const fail = async () => {
    await admin.from('room_auth_attempts').insert({ user_id: user.id, room_id: roomId });
    return NextResponse.json({ error: 'That code is wrong or has expired.' }, { status: 400 });
  };

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
  if (!email) return fail();

  const verifier = createAnonClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data: verified, error: otpErr } = await verifier.auth.verifyOtp({ email, token: otp, type: 'email' });
  if (otpErr || verified?.user?.id !== room.owner_id) return fail();

  const { error: rpcErr } = await admin.rpc('reset_room_password_by_owner', {
    p_room_id: roomId,
    p_new_kdf_salt: kdfSalt,
    p_new_wrapped_key: wrappedKey,
    p_new_wrapped_iv: wrappedIv,
    p_new_auth_token: authToken,
  });
  if (rpcErr) return NextResponse.json({ error: 'Could not reset the password. Try again.' }, { status: 500 });

  return NextResponse.json({ ok: true });
}
