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

const adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function testGuest() {
  console.log('--- Testing Guest Auth Pipeline ---');
  const guestId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const guestEmail = `guest_${guestId}@guest.chataf.internal`;
  const guestPassword = `GuestPass_${crypto.randomUUID()}`;

  const { data, error } = await adminClient.auth.admin.createUser({
    email: guestEmail,
    password: guestPassword,
    email_confirm: true,
    user_metadata: { is_guest: true }
  });
  if (error) throw error;
  console.log('  ✓ [PASS] Guest user created via admin client:', data.user.id);

  // Sign in as that guest user with anon public client
  const publicClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: signinData, error: signinErr } = await publicClient.auth.signInWithPassword({
    email: guestEmail,
    password: guestPassword
  });
  if (signinErr) throw signinErr;
  console.log('  ✓ [PASS] Public client signed in as guest successfully!');

  // Verify guest user can fetch room salt
  const { data: salt, error: saltErr } = await publicClient.rpc('get_room_kdf_salt', {
    p_room_id: '5ac723f4-60b8-4426-a848-62e9780f712d'
  });
  if (saltErr) throw saltErr;
  console.log('  ✓ [PASS] Guest authenticated client fetched room salt:', salt);

  // Clean up test guest user
  await adminClient.auth.admin.deleteUser(data.user.id);
  console.log('Guest Auth Pipeline Finished: All checks passed!');
}

testGuest().catch(err => {
  console.error('Test Guest Failed:', err);
  process.exit(1);
});
