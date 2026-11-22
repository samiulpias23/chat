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

async function main() {
  await client.connect();
  console.log('Connected to DB...');

  // 1. Add enum values outside transaction block
  try {
    await client.query("ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'admin';");
    await client.query("ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'banned';");
    console.log('Enum values committed.');
  } catch (e) {
    console.log('Enum values note:', e.message);
  }

  // 2. Add column and create functions
  const sql = `
  alter table room_members add column if not exists nickname varchar(50);

  create or replace function public.is_room_admin_or_owner(p_room uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from rooms where id = p_room and owner_id = auth.uid()
    ) or exists (
      select 1 from room_members where room_id = p_room and user_id = auth.uid() and role in ('owner', 'admin')
    );
  $$;

  create or replace function public.is_room_member(p_room uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from room_members
      where room_id = p_room and user_id = auth.uid() and role <> 'banned'
    );
  $$;

  create or replace function public.set_member_role(
    p_room_id uuid,
    p_user_id uuid,
    p_role member_role
  ) returns boolean
  language plpgsql security definer set search_path = public as $$
  declare
    v_is_owner boolean;
    v_target_is_owner boolean;
  begin
    if not public.is_room_admin_or_owner(p_room_id) then
      raise exception 'Unauthorized: Only room owner or admins can manage roles';
    end if;

    select (owner_id = p_user_id) into v_target_is_owner from rooms where id = p_room_id;
    if coalesce(v_target_is_owner, false) then
      raise exception 'Cannot modify the room owner';
    end if;

    select (owner_id = auth.uid()) into v_is_owner from rooms where id = p_room_id;
    if p_role = 'admin' and not coalesce(v_is_owner, false) then
      raise exception 'Only the room owner can grant admin access';
    end if;

    update room_members
       set role = p_role
     where room_id = p_room_id and user_id = p_user_id;

    return found;
  end $$;

  create or replace function public.set_member_nickname(
    p_room_id uuid,
    p_user_id uuid,
    p_nickname text
  ) returns boolean
  language plpgsql security definer set search_path = public as $$
  begin
    if not (public.is_room_admin_or_owner(p_room_id) or auth.uid() = p_user_id) then
      raise exception 'Unauthorized';
    end if;

    update room_members
       set nickname = nullif(trim(p_nickname), '')
     where room_id = p_room_id and user_id = p_user_id;

    return found;
  end $$;

  create or replace function public.add_member_by_uuid(
    p_room_id uuid,
    p_user_id uuid,
    p_role member_role default 'member',
    p_nickname text default null
  ) returns boolean
  language plpgsql security definer set search_path = public as $$
  begin
    if not public.is_room_admin_or_owner(p_room_id) then
      raise exception 'Unauthorized: Only room owner or admins can add members';
    end if;

    if not exists (select 1 from auth.users where id = p_user_id) then
      raise exception 'User with this UUID was not found';
    end if;

    insert into room_members (room_id, user_id, role, nickname)
    values (p_room_id, p_user_id, p_role, nullif(trim(p_nickname), ''))
    on conflict (room_id, user_id) do update
      set role = case when room_members.role = 'owner' then 'owner' else excluded.role end,
          nickname = coalesce(excluded.nickname, room_members.nickname);

    return true;
  end $$;

  grant execute on function public.is_room_admin_or_owner(uuid),
    public.set_member_role(uuid, uuid, member_role),
    public.set_member_nickname(uuid, uuid, text),
    public.add_member_by_uuid(uuid, uuid, member_role, text)
    to authenticated;
  `;

  await client.query(sql);
  console.log('Room member management migration applied successfully!');
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
