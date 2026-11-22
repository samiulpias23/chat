import fs from 'node:fs';
import path from 'node:path';
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

const sql = `
drop function if exists public.create_room_order(text,int,text,text,text,text,text);
drop function if exists public.create_room_order(text,int,text,uuid,text,text,text,text);

create or replace function public.create_room_order(
  p_name text,
  p_duration int,
  p_tx_hash text,
  p_room_id uuid default null,
  p_kdf_salt text default null,
  p_wrapped_key text default null,
  p_wrapped_iv text default null,
  p_auth_token text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room_id uuid := coalesce(p_room_id, gen_random_uuid());
  v_order_id uuid;
  v_clean_tx text := lower(trim(p_tx_hash));
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an account to create a room';
  end if;

  if not (v_clean_tx ~ '^0x[0-9a-f]{64}$') then
    raise exception 'Invalid transaction hash. Must be 66 characters starting with 0x.';
  end if;

  if exists (select 1 from room_orders where tx_hash = v_clean_tx) then
    raise exception 'This transaction hash has already been used for another order.';
  end if;

  if p_duration not in (1, 2, 3, 6, 12, 24) then
    raise exception 'Invalid duration';
  end if;

  delete from rooms where owner_id = auth.uid() and status = 'pending_payment'
    and not exists (select 1 from room_orders where room_id = rooms.id);

  insert into rooms (id, owner_id, name, kdf_salt, wrapped_room_key, wrapped_key_iv, auth_verifier_hash, status)
  values (
    v_room_id,
    auth.uid(),
    trim(p_name),
    p_kdf_salt,
    p_wrapped_key,
    p_wrapped_iv,
    case when p_auth_token is not null then crypt(p_auth_token, gen_salt('bf', 10)) else null end,
    'pending_payment'
  );

  insert into room_members (room_id, user_id, role) values (v_room_id, auth.uid(), 'owner')
  on conflict (room_id, user_id) do update set role = 'owner';

  insert into room_orders (room_id, user_id, duration_months, amount_usd, tx_hash, status)
  values (v_room_id, auth.uid(), p_duration, p_duration * 1.00, v_clean_tx, 'pending')
  returning id into v_order_id;

  return jsonb_build_object('room_id', v_room_id, 'order_id', v_order_id);
end $$;

grant execute on function public.create_room_order(text,int,text,uuid,text,text,text,text) to authenticated;
`;

async function main() {
  await client.connect();
  await client.query(sql);
  console.log('create_room_order updated with optional p_room_id!');
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
