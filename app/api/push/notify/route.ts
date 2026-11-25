import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Target {
  out_room_id: string;
  out_endpoint: string;
  out_p256dh: string;
  out_auth: string;
}

// Called by the sender after inserting a message. The push carries only the room id, never content.
export async function POST(request: Request) {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return NextResponse.json({ error: 'Push is not configured' }, { status: 503 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const messageId = body?.messageId;
  if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // The RPC checks that the caller sent this message and lets each message notify only once
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('claim_push_targets', { p_message_id: messageId, p_sender: user.id });
  if (error) return NextResponse.json({ error: 'Could not notify' }, { status: 500 });

  webpush.setVapidDetails(subject, publicKey, privateKey);
  const gone: string[] = [];
  await Promise.all(
    ((data ?? []) as Target[]).map(async (t) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.out_endpoint, keys: { p256dh: t.out_p256dh, auth: t.out_auth } },
          JSON.stringify({ roomId: t.out_room_id }),
          { TTL: 3600, urgency: 'high', timeout: 5000 }
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(t.out_endpoint);
      }
    })
  );
  if (gone.length) await admin.from('push_subscriptions').delete().in('endpoint', gone);

  return NextResponse.json({ ok: true });
}
