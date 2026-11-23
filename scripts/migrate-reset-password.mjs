import fs from 'node:fs';
import pg from 'pg';

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

const client = new pg.Client({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  console.log('Connected to DB...');

  const sql = `
-- Owner-email OTP reset (called only by /api/rooms/reset-password after Supabase verified the OTP).
-- The old RMK is unrecoverable without the old password, so history under it is expired (cron purges blobs).
create or replace function public.reset_room_password_by_owner(
  p_room_id uuid, p_new_kdf_salt text, p_new_wrapped_key text, p_new_wrapped_iv text, p_new_auth_token text
) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  update rooms set kdf_salt = p_new_kdf_salt, wrapped_room_key = p_new_wrapped_key,
         wrapped_key_iv = p_new_wrapped_iv,
         auth_verifier_hash = crypt(p_new_auth_token, gen_salt('bf', 10))
   where id = p_room_id and status = 'active' and expires_at > now();
  if not found then raise exception 'Room not found or expired'; end if;
  update messages set expires_at = now() where room_id = p_room_id and expires_at > now();
  delete from room_auth_attempts where room_id = p_room_id;
  return true;
end $$;
revoke execute on function public.reset_room_password_by_owner(uuid,text,text,text,text) from public, anon, authenticated;
grant  execute on function public.reset_room_password_by_owner(uuid,text,text,text,text) to service_role;

`;
  await client.query(sql);
  console.log('reset_room_password_by_owner installed.');
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
