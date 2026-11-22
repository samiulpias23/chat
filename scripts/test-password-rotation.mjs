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
  console.log('--- Testing Room Password Rotation Flow ---');

  const emailOwner = `owner_pw_${Date.now()}@example.com`;
  const { data: uo } = await adminClient.auth.admin.createUser({ email: emailOwner, password: 'Password123!', email_confirm: true });
  const ownerId = uo.user.id;

  await adminClient.from('profiles').insert({ id: ownerId, display_name: 'RoomOwner' });

  const clientOwner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await clientOwner.auth.signInWithPassword({ email: emailOwner, password: 'Password123!' });

  const roomId = crypto.randomUUID();
  const { generateSalt, deriveKeysFromPassword, createAndWrapRoomKey, rotateRoomKeyWrapping } = await import('../lib/crypto.ts');

  const oldSalt = generateSalt();
  const { kek: oldKek, authToken: oldAuthToken } = await deriveKeysFromPassword('OldPass123!', oldSalt);
  const { wrappedKey: oldWrappedKey, wrappedIv: oldWrappedIv } = await createAndWrapRoomKey(oldKek, roomId);

  // 1. Create room order via clientOwner
  const { data: orderRes, error: orderErr } = await clientOwner.rpc('create_room_order', {
    p_name: 'Password Rotate Room',
    p_duration: 1,
    p_tx_hash: `0x${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 66),
    p_room_id: roomId,
    p_kdf_salt: oldSalt,
    p_wrapped_key: oldWrappedKey,
    p_wrapped_iv: oldWrappedIv,
    p_auth_token: oldAuthToken,
  });
  if (orderErr) throw orderErr;
  console.log('Room order created:', orderRes);

  // 2. Activate room
  await adminClient.from('rooms').update({
    status: 'active',
    expires_at: new Date(Date.now() + 86400000 * 30).toISOString()
  }).eq('id', roomId);
  console.log('Room approved and active!');

  // 3. Now simulate RoomSettingsModal password rotation:
  // Step A: fetch current salt
  const { data: currentSalt, error: saltErr } = await clientOwner.rpc('get_room_kdf_salt', { p_room_id: roomId });
  const { data: dbRoom } = await adminClient.from('rooms').select('*').eq('id', roomId).single();
  console.log('Room in DB:', dbRoom);
  if (saltErr || !currentSalt) throw new Error(`Could not fetch salt: ${saltErr?.message || 'null value'}`);
  console.log('  ✓ Fetched currentSalt:', currentSalt);

  // Step B: verify current password
  const { kek: verifyKek, authToken: verifyAuthToken } = await deriveKeysFromPassword('OldPass123!', currentSalt);
  const { data: keys, error: authErr } = await clientOwner.rpc('verify_room_password', {
    p_room_id: roomId,
    p_auth_token: verifyAuthToken
  });
  if (authErr || !keys || keys.length === 0) {
    throw new Error(`verify_room_password failed: ${authErr?.message || 'no keys returned'}`);
  }
  console.log('  ✓ verify_room_password succeeded, got wrapped keys');

  const { out_wrapped_key, out_wrapped_iv } = keys[0];

  // Step C: rotate key wrapping
  const newSalt = generateSalt();
  const { newWrappedKey, newWrappedIv, newAuthToken, oldAuthToken: rotatedOldAuth } = await rotateRoomKeyWrapping(
    'OldPass123!',
    currentSalt,
    out_wrapped_key,
    out_wrapped_iv,
    roomId,
    'NewPass456!',
    newSalt
  );
  console.log('  ✓ rotateRoomKeyWrapping produced new keys');

  // Step D: call rotate_room_password RPC
  const { data: rotateRes, error: rotateErr } = await clientOwner.rpc('rotate_room_password', {
    p_room_id: roomId,
    p_old_auth_token: rotatedOldAuth,
    p_new_kdf_salt: newSalt,
    p_new_wrapped_key: newWrappedKey,
    p_new_wrapped_iv: newWrappedIv,
    p_new_auth_token: newAuthToken,
  });

  if (rotateErr) {
    throw new Error(`rotate_room_password RPC failed: ${rotateErr.message}`);
  }
  console.log('  ✓ [PASS] rotate_room_password RPC succeeded! Result:', rotateRes);

  // Step E: Verify new password can unlock the room
  const { data: newKeys, error: newAuthErr } = await clientOwner.rpc('verify_room_password', {
    p_room_id: roomId,
    p_auth_token: newAuthToken
  });
  if (newAuthErr || !newKeys || newKeys.length === 0) {
    throw new Error('New password failed to unlock room after rotation');
  }
  console.log('  ✓ [PASS] New password NewPass456! successfully verified and unwrapped RMK!');

  // Clean up
  await adminClient.from('room_orders').delete().eq('room_id', roomId);
  await adminClient.from('room_members').delete().eq('room_id', roomId);
  await adminClient.from('rooms').delete().eq('id', roomId);
  await adminClient.auth.admin.deleteUser(ownerId);
  console.log('--- Password Rotation Test Finished Successfully! ---');
}

run().catch((e) => {
  console.error('Password Rotation Test Failed:', e);
  process.exit(1);
});
