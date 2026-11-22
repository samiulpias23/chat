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
  create or replace function public.rotate_room_password(
    p_room_id uuid, p_old_auth_token text,
    p_new_kdf_salt text, p_new_wrapped_key text, p_new_wrapped_iv text, p_new_auth_token text
  ) returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
  declare v_hash text;
  begin
    if not public.is_room_admin_or_owner(p_room_id) then
      raise exception 'Unauthorized: Only room owner or admins can rotate password';
    end if;

    select auth_verifier_hash into v_hash from rooms
     where id = p_room_id and status = 'active' and (expires_at is null or expires_at > now())
     for update;

    if v_hash is null or v_hash <> crypt(p_old_auth_token, v_hash) then
      raise exception 'Unauthorized or wrong current password';
    end if;

    update rooms set kdf_salt = p_new_kdf_salt, wrapped_room_key = p_new_wrapped_key,
           wrapped_key_iv = p_new_wrapped_iv,
           auth_verifier_hash = crypt(p_new_auth_token, gen_salt('bf', 10))
     where id = p_room_id;
    return true;
  end $$;

  grant execute on function public.rotate_room_password(uuid, text, text, text, text, text) to authenticated;
  `;

  await client.query(sql);
  console.log('SUCCESS: Deployed improved rotate_room_password RPC!');
  await client.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
