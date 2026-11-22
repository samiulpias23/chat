import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

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
  console.log('--- Testing Room Members Management ---');

  // 1. Create 2 test users
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
    { id: ownerId, display_name: 'RoomOwner' },
    { id: memberId, display_name: 'RegularMember' }
  ]);

  // Client for owner
  const clientOwner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await clientOwner.auth.signInWithPassword({ email: emailOwner, password: 'Password123!' });

  // 2. Owner creates a room
  const { data: roomId, error: roomErr } = await clientOwner.rpc('create_room', { p_name: 'Alpha Room' });
  if (roomErr) throw roomErr;
  console.log('  ✓ [PASS] Room created:', roomId);

  // 3. Owner adds member by UUID
  const { data: addRes, error: addErr } = await clientOwner.rpc('add_member_by_uuid', {
    p_room_id: roomId,
    p_user_id: memberId,
    p_role: 'member',
    p_nickname: 'AgentGhost'
  });
  if (addErr) throw addErr;
  console.log('  ✓ [PASS] Owner added member by UUID with nickname AgentGhost');

  // 4. Verify get_room_members lists both
  const { data: members, error: gmErr } = await clientOwner.rpc('get_room_members', { p_room_id: roomId });
  if (gmErr) throw gmErr;
  if (!members || members.length !== 2) throw new Error(`Expected 2 members, got ${members?.length}`);
  console.log('  ✓ [PASS] get_room_members returns both owner and member');

  // 5. Owner gives admin access to member
  const { error: adminErr } = await clientOwner.rpc('set_member_role', {
    p_room_id: roomId,
    p_user_id: memberId,
    p_role: 'admin'
  });
  if (adminErr) throw adminErr;
  console.log('  ✓ [PASS] Owner granted admin access to member');

  // 6. Owner updates nickname
  const { error: nickErr } = await clientOwner.rpc('set_member_nickname', {
    p_room_id: roomId,
    p_user_id: memberId,
    p_nickname: 'CommanderGhost'
  });
  if (nickErr) throw nickErr;
  console.log('  ✓ [PASS] Owner updated nickname to CommanderGhost');

  // 7. Owner bans member
  const { error: banErr } = await clientOwner.rpc('set_member_role', {
    p_room_id: roomId,
    p_user_id: memberId,
    p_role: 'banned'
  });
  if (banErr) throw banErr;
  console.log('  ✓ [PASS] Owner banned member');

  // 8. Verify banned member can be unbanned
  const { error: unbanErr } = await clientOwner.rpc('set_member_role', {
    p_room_id: roomId,
    p_user_id: memberId,
    p_role: 'member'
  });
  if (unbanErr) throw unbanErr;
  console.log('  ✓ [PASS] Owner unbanned member back to regular member');

  // Clean up test data
  await adminClient.from('rooms').delete().eq('id', roomId);
  await adminClient.auth.admin.deleteUser(ownerId);
  await adminClient.auth.admin.deleteUser(memberId);
  console.log('Room Members Management Test Finished: All checks passed!');
}

run().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
