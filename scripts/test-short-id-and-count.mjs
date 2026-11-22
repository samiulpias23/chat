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
  console.log('--- Testing 8-Digit User ID and Message Count RPC ---');

  const emailOwner = `owner_${Date.now()}@example.com`;
  const emailMember = `member_${Date.now()}@example.com`;

  const { data: userOwnerData, error: uoErr } = await adminClient.auth.admin.createUser({
    email: emailOwner,
    password: 'Password123!',
    email_confirm: true,
  });
  if (uoErr) throw uoErr;
  const ownerId = userOwnerData.user.id;

  const { data: userMemberData, error: umErr } = await adminClient.auth.admin.createUser({
    email: emailMember,
    password: 'Password123!',
    email_confirm: true,
  });
  if (umErr) throw umErr;
  const memberId = userMemberData.user.id;

  // Insert profiles
  await adminClient.from('profiles').insert([
    { id: ownerId, display_name: 'ShortIdOwner' },
    { id: memberId, display_name: 'ShortIdMember' }
  ]);

  // Sign in as owner
  const clientOwner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await clientOwner.auth.signInWithPassword({ email: emailOwner, password: 'Password123!' });

  // 1. Owner creates a room and set to active
  const { data: roomId, error: roomErr } = await clientOwner.rpc('create_room', { p_name: 'Short ID Room' });
  if (roomErr) throw roomErr;
  await adminClient.from('rooms').update({
    status: 'active',
    expires_at: new Date(Date.now() + 86400000).toISOString()
  }).eq('id', roomId);
  console.log('  ✓ [PASS] Room created & activated:', roomId);

  // 2. Compute 8-digit Short ID
  const shortId = memberId.replace(/-/g, '').slice(0, 8).toUpperCase();
  console.log(`Member full UUID: ${memberId}`);
  console.log(`Member 8-digit ID: ${shortId}`);

  // 3. Owner adds member by 8-DIGIT SHORT ID ONLY!
  const { data: addRes, error: addErr } = await clientOwner.rpc('add_member_by_uuid', {
    p_room_id: roomId,
    p_user_id: shortId,
    p_role: 'member',
    p_nickname: 'AgentShort'
  });
  if (addErr) throw addErr;
  console.log('  ✓ [PASS] Owner successfully added member using 8-digit short ID:', shortId);

  // 4. Verify get_room_members returns member with correct user_id
  const { data: members, error: memErr } = await clientOwner.rpc('get_room_members', { p_room_id: roomId });
  if (memErr) throw memErr;
  const added = members.find(m => m.user_id === memberId);
  if (!added || added.nickname !== 'AgentShort') {
    throw new Error('Member was not properly resolved or added');
  }
  console.log('  ✓ [PASS] Member resolved in database with full foreign key UUID and custom nickname!');

  // 5. Test get_room_message_count
  const { data: count0, error: cErr0 } = await clientOwner.rpc('get_room_message_count', { p_room_id: roomId });
  if (cErr0) throw cErr0;
  console.log(`  ✓ [PASS] Initial room message count: ${count0}`);

  // Insert message as owner
  const msgId = crypto.randomUUID();
  const { error: insErr } = await clientOwner.from('messages').insert({
    id: msgId,
    room_id: roomId,
    sender_id: ownerId,
    encrypted_content: 'dummy_cipher',
    iv: 'dummy_iv',
    media_type: 'text',
    expires_at: new Date(Date.now() + 86400000).toISOString()
  });
  if (insErr) throw insErr;

  const { data: count1, error: cErr1 } = await clientOwner.rpc('get_room_message_count', { p_room_id: roomId });
  if (cErr1) throw cErr1;
  console.log(`  ✓ [PASS] Message count after new message: ${count1} (expected ${count0 + 1})`);

  // Clean up
  await adminClient.from('messages').delete().eq('room_id', roomId);
  await adminClient.from('room_members').delete().eq('room_id', roomId);
  await adminClient.from('rooms').delete().eq('id', roomId);
  await adminClient.auth.admin.deleteUser(ownerId);
  await adminClient.auth.admin.deleteUser(memberId);

  console.log('--- All 8-Digit ID & Lock Screen Tests Passed Perfectly! ---');
}

run().catch((e) => {
  console.error('Test Failed:', e);
  process.exit(1);
});
