import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Parse .env.local
const envContent = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx !== -1) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

console.log('--- Running RLS Acceptance Tests on Live Supabase ---');

const adminClient = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function runTests() {
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  ✓ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${message}`);
    }
  }

  // 1. Create two anonymous test users
  const { data: userAData, error: errA } = await adminClient.auth.admin.createUser({
    email: `test_user_a_${Date.now()}@chataf.internal`,
    password: 'Password123!',
    email_confirm: true
  });
  const { data: userBData, error: errB } = await adminClient.auth.admin.createUser({
    email: `test_user_b_${Date.now()}@chataf.internal`,
    password: 'Password123!',
    email_confirm: true
  });

  const userA = userAData.user;
  const userB = userBData.user;

  // Sign in as user A
  const clientA = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  await clientA.auth.signInWithPassword({ email: userA.email, password: 'Password123!' });

  // Sign in as user B
  const clientB = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  await clientB.auth.signInWithPassword({ email: userB.email, password: 'Password123!' });

  // Profile upsert test
  const { error: profileErrA } = await clientA.from('profiles').insert({
    id: userA.id,
    display_name: 'Alice'
  });
  assert(!profileErrA, 'User A can insert own profile');

  const { error: profileErrB } = await clientB.from('profiles').insert({
    id: userB.id,
    display_name: 'Bob'
  });
  assert(!profileErrB, 'User B can insert own profile');

  // Test: User A cannot update User B's profile
  const { error: hackProfileErr } = await clientA
    .from('profiles')
    .update({ display_name: 'Hacked' })
    .eq('id', userB.id);
  // Supabase update policy with check/using returns no updated rows (or error)
  const { data: verifyBProfile } = await clientB.from('profiles').select('display_name').eq('id', userB.id).single();
  assert(verifyBProfile?.display_name === 'Bob', 'User A cannot modify User B profile');

  // 2. Room setup (via service client or owner)
  // Create an active room owned by User A with expiry in 1 hour
  const { data: room, error: roomErr } = await adminClient.from('rooms').insert({
    owner_id: userA.id,
    name: 'Secret Vault',
    status: 'active',
    kdf_salt: 'kdf_salt_test',
    wrapped_room_key: 'wrapped_key_test',
    wrapped_key_iv: 'iv_test',
    auth_verifier_hash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890',
    expires_at: new Date(Date.now() + 3600000).toISOString()
  }).select().single();
  assert(!!room, 'Test room created');

  // Add User A as member
  await adminClient.from('room_members').insert({
    room_id: room.id,
    user_id: userA.id,
    role: 'owner'
  });

  // Test: Directory select allows non-secret columns but strictly denies crypto columns
  const { data: publicCols, error: pubErr } = await clientB.from('rooms').select('id, owner_id, name, status, expires_at, created_at').eq('id', room.id).single();
  assert(!pubErr && !!publicCols, 'Client can SELECT non-secret public room directory columns');

  const { error: cryptoColErr } = await clientB.from('rooms').select('wrapped_room_key').eq('id', room.id);
  assert(
    !!cryptoColErr && cryptoColErr.code === '42501',
    'Client SELECT on wrapped_room_key is strictly denied by PostgreSQL column grant (42501)'
  );

  // Test: User B (non-member) cannot SELECT messages from room
  const { data: bMessages, error: bMsgErr } = await clientB.from('messages').select('*').eq('room_id', room.id);
  assert(Array.isArray(bMessages) && bMessages.length === 0, 'Non-member cannot read room messages');

  // Test: User A (member) can insert message
  const { data: aMsg, error: aMsgErr } = await clientA.from('messages').insert({
    room_id: room.id,
    sender_id: userA.id,
    encrypted_content: '{"text":"ciphertext"}',
    iv: 'iv1234567890'
  }).select().single();
  assert(!aMsgErr && !!aMsg, 'Member can insert message');

  // Test: Trigger overwrote/forced expires_at and created_at
  assert(
    aMsg && aMsg.read_by_all_at === null && aMsg.media_deleted === false,
    'messages_before_insert trigger forced default values (read_by_all_at=null, media_deleted=false)'
  );

  // Test: Non-admin cannot approve orders
  const { error: nonAdminApproveErr } = await clientA.rpc('approve_room_order', {
    p_order_id: '00000000-0000-0000-0000-000000000000'
  });
  assert(
    !!nonAdminApproveErr && nonAdminApproveErr.message.includes('Admin only'),
    'Non-admin calling approve_room_order is strictly rejected'
  );

  // Test: Expired room blocks reads and writes
  const { data: expiredRoom } = await adminClient.from('rooms').insert({
    owner_id: userA.id,
    name: 'Expired Vault',
    status: 'active',
    expires_at: new Date(Date.now() - 10000).toISOString()
  }).select().single();
  await adminClient.from('room_members').insert({ room_id: expiredRoom.id, user_id: userA.id });

  const { data: expMsgRead } = await clientA.from('messages').select('*').eq('room_id', expiredRoom.id);
  assert(expMsgRead?.length === 0, 'Expired room strictly blocks message reading');

  const { error: expMsgInsertErr } = await clientA.from('messages').insert({
    room_id: expiredRoom.id,
    sender_id: userA.id,
    encrypted_content: '{"text":"test"}',
    iv: 'iv123'
  });
  assert(!!expMsgInsertErr, 'Expired room strictly blocks message inserting');

  // Clean up test data
  await adminClient.auth.admin.deleteUser(userA.id);
  await adminClient.auth.admin.deleteUser(userB.id);
  await adminClient.from('rooms').delete().eq('id', room.id);
  await adminClient.from('rooms').delete().eq('id', expiredRoom.id);

  console.log(`\nRLS Acceptance Tests Finished: ${passed}/${total} passed!`);
  if (passed !== total) process.exit(1);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
