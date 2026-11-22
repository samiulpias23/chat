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
  -- 1. get_room_unread_count: Only counts UNREAD messages created AFTER viewer's last_read_at, excluding own sent messages
  create or replace function public.get_room_unread_count(p_room_id uuid)
  returns int
  language plpgsql security definer set search_path = public as $$
  declare
    v_user uuid := auth.uid();
    v_last_read timestamptz;
    v_count int;
  begin
    if v_user is not null then
      select last_read_at into v_last_read
        from room_members
       where room_id = p_room_id and user_id = v_user;
    end if;

    if v_last_read is not null then
      select coalesce(count(*)::int, 0) into v_count
        from messages
       where room_id = p_room_id
         and created_at > v_last_read
         and (v_user is null or sender_id <> v_user)
         and (expires_at is null or expires_at > now());
    else
      select coalesce(count(*)::int, 0) into v_count
        from messages
       where room_id = p_room_id
         and (v_user is null or sender_id <> v_user)
         and (expires_at is null or expires_at > now());
    end if;

    return coalesce(v_count, 0);
  end;
  $$;

  grant execute on function public.get_room_unread_count(uuid) to anon, authenticated;

  -- 2. get_room_message_count: Aliased to unread count for backwards-compatibility
  create or replace function public.get_room_message_count(p_room_id uuid)
  returns int
  language plpgsql security definer set search_path = public as $$
  begin
    return public.get_room_unread_count(p_room_id);
  end;
  $$;

  grant execute on function public.get_room_message_count(uuid) to anon, authenticated;

  -- 3. mark_room_read: Updates last_read_at for current user and triggers 24h expiration once read by all
  create or replace function public.mark_room_read(p_room_id uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
  declare
    v_min timestamptz;
    v_user uuid := auth.uid();
  begin
    if v_user is null then return; end if;

    -- Ensure room_members record exists
    if not exists (select 1 from room_members where room_id = p_room_id and user_id = v_user) then
      if exists (select 1 from rooms where id = p_room_id and owner_id = v_user) then
        insert into room_members (room_id, user_id, role, last_read_at, last_active_at)
        values (p_room_id, v_user, 'owner', now(), now())
        on conflict (room_id, user_id) do update set last_read_at = now(), last_active_at = now();
      else
        insert into room_members (room_id, user_id, role, last_read_at, last_active_at)
        values (p_room_id, v_user, 'member', now(), now())
        on conflict (room_id, user_id) do update set last_read_at = now(), last_active_at = now();
      end if;
    else
      update room_members set last_read_at = now(), last_active_at = now()
       where room_id = p_room_id and user_id = v_user;
    end if;

    -- Check if all active members have read messages
    select min(last_read_at) into v_min from room_members
     where room_id = p_room_id and last_active_at > now() - interval '7 days';

    if v_min is not null then
      update messages
         set read_by_all_at = now(),
             expires_at = least(now() + interval '24 hours', created_at + interval '7 days')
       where room_id = p_room_id and read_by_all_at is null and created_at <= v_min;
    end if;
  end;
  $$;

  grant execute on function public.mark_room_read(uuid) to anon, authenticated;
  `;

  await client.query(sql);
  console.log('SUCCESS: Deployed unread count and read receipt migration to Supabase PostgreSQL!');
  await client.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
