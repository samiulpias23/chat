import { createClient } from '@/lib/supabase/client';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported() || Notification.permission !== 'granted') return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function save(subscription: PushSubscription) {
  const { endpoint, keys } = subscription.toJSON();
  const { error } = await createClient().rpc('save_push_subscription', {
    p_endpoint: endpoint,
    p_p256dh: keys?.p256dh,
    p_auth: keys?.auth,
  });
  if (error) throw new Error('Could not save this device. Try again in a moment.');
}

function decodeKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function isPushEnabled(): Promise<boolean> {
  return Boolean(await currentSubscription());
}

// Must be called from a tap: browsers only show the permission prompt after a user gesture.
export async function enablePush(): Promise<void> {
  if (!VAPID_PUBLIC_KEY) throw new Error('Notifications are not set up on this server yet.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permission was not granted. Allow notifications to turn this on.');

  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(VAPID_PUBLIC_KEY),
    }));

  try {
    await save(subscription);
  } catch (err) {
    await subscription.unsubscribe();
    throw err;
  }
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await createClient().rpc('delete_push_subscription', { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

export async function syncPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription) await save(subscription);
}

// Fire and forget: a failed notification must never fail the send
export function notifyRoom(messageId: string): void {
  fetch('/api/push/notify', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  }).catch(() => {});
}
