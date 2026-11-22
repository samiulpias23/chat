import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env.local', 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const idx = t.indexOf('=');
  if (idx !== -1) {
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[t.slice(0, idx).trim()] = val;
  }
}

const adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function run() {
  console.log('--- Testing Seen Status & Unread Count Logic ---');

  const emailA = `user_a_${Date.now()}@example.com`;
  const emailB = `user_b_${Date.now()}@example.com`;

  // Create users
  const { data: uA } = await adminClient.auth.admin.createUser({ email: emailA, password: 'Password123!', email_confirm: true });
  const { data: uB } = await adminClient.auth.admin.createUser({ email: emailB, password: 'Password123!', email_confirm: true });
  const userAId = uA.user.id;
  const userBId = uB.user.id;

  await adminClient.from('profiles').insert([
    { id: userAId, display_name: 'UserA' },
    { id: userBId, display_name: 'UserB' },
  ]);

  // Clients
  const clientA = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await clientA.auth.signInWithPassword({ email: emailA, password: 'Password123!' });

  const clientB = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await clientB.auth.signInWithPassword({ email: emailB, password: 'Password123!' });

  // 1. User A creates and activates a room
  const { data: roomId } = await clientA.rpc('create_room', { p_name: 'Seen Status Room' });
  await adminClient.from('rooms').update({
    status: 'active',
    expires_at: new Date(Date.now() + 86400000).toISOString()
  }).eq('id', roomId);

  // 2. Add User B to the room
  await clientA.rpc('add_member_by_uuid', {
    p_room_id: roomId,
    p_user_id: userBId,
    p_role: 'member',
  });

  // 3. Both users initial unread counts should be 0
  const { data: countA0 } = await clientA.rpc('get_room_unread_count', { p_room_id: roomId });
  const { data: countB0 } = await clientB.rpc('get_room_unread_count', { p_room_id: roomId });
  console.log(`Initial unread -> User A: ${countA0}, User B: ${countB0}`);
  if (countA0 !== 0 || countB0 !== 0) throw new Error('Expected 0 initial unread for both');

  // 4. User A sends a message ("Hello")
  // User B's last_read_at is slightly in the past
  await adminClient.from('room_members').update({
    last_read_at: new Date(Date.now() - 5000).toISOString()
  }).eq('room_id', roomId).eq('user_id', userBId);

  await new Promise(r => setTimeout(r, 100));

  await clientA.from('messages').insert({
    id: crypto.randomUUID(),
    room_id: roomId,
    sender_id: userAId,
    encrypted_content: 'cipher_hello',
    iv: 'iv_hello',
    media_type: 'text'
  });

  // 5. Check unread counts:
  // User A sent the message and saw it -> User A unread must be 0!
  // User B has not seen it yet -> User B unread must be 1!
  const { data: countA1 } = await clientA.rpc('get_room_unread_count', { p_room_id: roomId });
  const { data: countB1 } = await clientB.rpc('get_room_unread_count', { p_room_id: roomId });
  console.log(`After User A sends "Hello" -> User A unread: ${countA1} (expected 0), User B unread: ${countB1} (expected 1)`);

  if (countA1 !== 0) throw new Error(`User A should have 0 unread messages for their own message, but got ${countA1}`);
  if (countB1 !== 1) throw new Error(`User B should have 1 unread message, but got ${countB1}`);
  console.log('  ✓ [PASS] Sender has 0 unread; Recipient has 1 unread!');

  // 6. User B enters/unlocks the room -> calls mark_room_read
  await clientB.rpc('mark_room_read', { p_room_id: roomId });

  // 7. Check unread count after User B marks room read -> both must be 0!
  const { data: countB2 } = await clientB.rpc('get_room_unread_count', { p_room_id: roomId });
  console.log(`After User B marks read -> User B unread: ${countB2} (expected 0)`);
  if (countB2 !== 0) throw new Error(`User B should have 0 unread after viewing room, but got ${countB2}`);
  console.log('  ✓ [PASS] Room lock screen now shows 0 unread once seen!');

  // Clean up
  await adminClient.from('messages').delete().eq('room_id', roomId);
  await adminClient.from('room_members').delete().eq('room_id', roomId);
  await adminClient.from('rooms').delete().eq('id', roomId);
  await adminClient.auth.admin.deleteUser(userAId);
  await adminClient.auth.admin.deleteUser(userBId);

  console.log('--- All Seen Status & Unread Count Tests Passed Perfectly! ---');
}

run().catch((e) => {
  console.error('Test Failed:', e);
  process.exit(1);
});
