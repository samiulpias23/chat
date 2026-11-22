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
  -- 1. Get room message count for lock screen
  create or replace function public.get_room_message_count(p_room_id uuid)
  returns int
  language sql stable security definer set search_path = public as $$
    select coalesce(count(*)::int, 0)
      from messages
     where room_id = p_room_id
       and expires_at > now();
  $$;

  grant execute on function public.get_room_message_count(uuid) to anon, authenticated;

  -- 2. Update add_member_by_uuid to support BOTH 8-character short ID or full UUID
  create or replace function public.add_member_by_uuid(
    p_room_id uuid,
    p_user_id text,
    p_role member_role default 'member',
    p_nickname text default null
  ) returns boolean
  language plpgsql security definer set search_path = public as $$
  declare
    v_target_uuid uuid;
  begin
    if not public.is_room_admin_or_owner(p_room_id) then
      raise exception 'Unauthorized: Only room owner or admins can add members';
    end if;

    -- Match by full UUID or by 8+ char short alphanumeric ID prefix
    select id into v_target_uuid
      from auth.users
     where id = public.try_uuid(trim(p_user_id))
        or replace(id::text, '-', '') ilike (trim(p_user_id) || '%')
     limit 1;

    if v_target_uuid is null then
      raise exception 'User with ID "%" was not found', p_user_id;
    end if;

    insert into room_members (room_id, user_id, role, nickname)
    values (p_room_id, v_target_uuid, p_role, nullif(trim(p_nickname), ''))
    on conflict (room_id, user_id) do update
      set role = case when room_members.role = 'owner' then 'owner' else excluded.role end,
          nickname = coalesce(excluded.nickname, room_members.nickname);

    return true;
  end $$;

  grant execute on function public.add_member_by_uuid(uuid, text, member_role, text) to authenticated;
  `;

  await client.query(sql);
  console.log('Migration for message count and 8-digit ID support applied successfully!');
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
