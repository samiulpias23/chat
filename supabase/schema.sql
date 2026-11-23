-- ============================================================================
-- CHATAF SCHEMA v1.3.0 (post-audit) — Supabase Postgres 15+
-- Principle: clients may only SELECT. Every mutation goes through a
-- SECURITY DEFINER RPC (or the narrow policies below). Default-deny otherwise.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- ENUMS -----------------------------------------------------------
do $$ begin
  create type room_status as enum ('pending_payment','unlocked_setup','active','expired');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type order_status as enum ('pending','held','approved','rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type member_role as enum ('owner','admin','member','banned');
exception when duplicate_object then null;
end $$;

-- ---------- TABLES ----------------------------------------------------------
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name varchar(50) not null check (length(trim(display_name)) > 0),
  created_at   timestamptz not null default now()
);

create table if not exists rooms (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete restrict,
  name               varchar(60) not null check (length(trim(name)) > 0),
  status             room_status not null default 'pending_payment',
  -- E2EE envelope. NEVER readable by clients directly (column grants below);
  -- released only by verify_room_password() after a rate-limited check.
  kdf_salt           text,   -- base64 16B; one salt, HKDF splits KEK / auth token
  wrapped_room_key   text,   -- base64 AES-GCM(KEK, RMK, aad=room_id)
  wrapped_key_iv     text,   -- base64 12B, fresh on every (re)wrap
  auth_verifier_hash text,   -- bcrypt(client_auth_token)
  expires_at         timestamptz,
  created_at         timestamptz not null default now()
);

create table if not exists room_orders (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references rooms(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  duration_months int not null check (duration_months in (1,2,3,6,12,24)),
  amount_usd     numeric(8,2) not null,
  tx_hash        varchar(66) not null unique
                 check (tx_hash ~ '^0x[0-9a-f]{64}$'),   -- lowercase only => UNIQUE can't be dodged by casing
  status         order_status not null default 'pending',
  admin_notes    text,
  reviewed_by    uuid references auth.users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  check (amount_usd = duration_months * 1.00)
);

create unique index if not exists one_open_order_per_room on room_orders(room_id) where status in ('pending','held');

create table if not exists room_members (
  room_id        uuid not null references rooms(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  role           member_role not null default 'member',
  nickname       varchar(50),
  joined_at      timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  last_read_at   timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists idx_room_members_user on room_members(user_id);

create table if not exists messages (
  id                uuid primary key default gen_random_uuid(), -- client may supply (needed for storage path)
  room_id           uuid not null references rooms(id) on delete cascade,
  sender_id         uuid not null references auth.users(id) on delete cascade,
  encrypted_content text not null check (length(encrypted_content) <= 16000), -- JSON incl. text, filenames, GIF url
  iv                varchar(24) not null,
  media_type        varchar(10) not null default 'text' check (media_type in ('text','photo','album','file','gif')),
  media_count       smallint not null default 0 check (media_count between 0 and 10),
  media_deleted     boolean not null default false,
  created_at        timestamptz not null default now(),
  read_by_all_at    timestamptz,
  expires_at        timestamptz not null default (now() + interval '7 days')
);
create index if not exists idx_messages_room_expires on messages(room_id, expires_at desc);
create index if not exists idx_messages_expires on messages(expires_at);

create table if not exists room_auth_attempts (  -- failed password attempts only
  id           bigserial primary key,
  user_id      uuid not null,
  room_id      uuid not null references rooms(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_auth_attempts on room_auth_attempts(room_id, user_id, attempted_at);

-- ---------- HELPERS (SECURITY DEFINER avoids RLS self-recursion) -------------
create or replace function public.try_uuid(t text) returns uuid
language plpgsql immutable as $$ begin return t::uuid; exception when others then return null; end $$;

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
$$;

create or replace function public.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from room_members
    where room_id = p_room and user_id = auth.uid() and role <> 'banned'
  )
$$;

create or replace function public.is_room_admin_or_owner(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from rooms where id = p_room and owner_id = auth.uid()
  ) or exists (
    select 1 from room_members where room_id = p_room and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

create or replace function public.is_room_live(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rooms where id = p_room and status = 'active' and expires_at > now())
$$;

create or replace function public.can_use_room(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_room is not null and public.is_room_member(p_room) and public.is_room_live(p_room)
$$;

create or replace function public.shares_room_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user = auth.uid() or exists (
    select 1 from room_members a join room_members b on a.room_id = b.room_id
    where a.user_id = auth.uid() and b.user_id = p_user)
$$;

-- ---------- PRIVILEGES: deny by default --------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

grant select on profiles, room_orders, room_members, messages to authenticated;
grant insert, update on profiles to authenticated;
grant insert on messages to authenticated;
-- rooms: crypto columns are NOT selectable by clients
grant select (id, owner_id, name, status, expires_at, created_at) on rooms to anon, authenticated;

grant execute on function public.is_admin(), public.is_room_member(uuid), public.is_room_live(uuid),
  public.can_use_room(uuid), public.shares_room_with(uuid), public.try_uuid(text) to authenticated;

-- ---------- RLS --------------------------------------------------------------
alter table profiles          enable row level security;
alter table rooms             enable row level security;
alter table room_orders       enable row level security;
alter table room_members      enable row level security;
alter table messages          enable row level security;
alter table room_auth_attempts enable row level security;

drop policy if exists profiles_read on profiles;
create policy profiles_read   on profiles for select to authenticated using (public.shares_room_with(id));

drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists rooms_read on rooms;
create policy rooms_read on rooms for select to anon, authenticated using (true);

drop policy if exists orders_read on room_orders;
create policy orders_read on room_orders for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists members_read on room_members;
create policy members_read on room_members for select to authenticated using (public.is_room_member(room_id));

drop policy if exists messages_read on messages;
create policy messages_read on messages for select to authenticated using (
  expires_at > now()
  and created_at > now() - interval '7 days'
  and (read_by_all_at is null or read_by_all_at > now() - interval '24 hours')
  and public.can_use_room(room_id)
);

drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert to authenticated with check (
  sender_id = auth.uid() and public.can_use_room(room_id)
);

-- Server-controlled columns can't be forged on insert.
create or replace function public.messages_before_insert() returns trigger
language plpgsql set search_path = public as $$
begin
  new.created_at := now(); new.read_by_all_at := null;
  new.expires_at := now() + interval '7 days'; new.media_deleted := false;
  return new;
end $$;

drop trigger if exists trg_messages_before_insert on messages;
create trigger trg_messages_before_insert before insert on messages
  for each row execute function public.messages_before_insert();

-- Sender has implicitly "read" their own message
create or replace function public.messages_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update room_members set last_read_at = new.created_at, last_active_at = now()
   where room_id = new.room_id and user_id = new.sender_id;
  return new;
end $$;

drop trigger if exists trg_messages_after_insert on messages;
create trigger trg_messages_after_insert after insert on messages
  for each row execute function public.messages_after_insert();

-- ---------- RPCs -------------------------------------------------------------
create or replace function public.create_room(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an account to create a room';
  end if;
  -- Purge abandoned draft rooms that have no order submitted
  delete from rooms where owner_id = auth.uid() and status = 'pending_payment'
    and not exists (select 1 from room_orders where room_id = rooms.id);

  insert into rooms (owner_id, name) values (auth.uid(), trim(p_name)) returning id into v_id;
  insert into room_members (room_id, user_id, role) values (v_id, auth.uid(), 'owner')
  on conflict (room_id, user_id) do update set role = 'owner';
  return v_id;
end $$;

create or replace function public.create_room_order(
  p_name text,
  p_duration int,
  p_tx_hash text,
  p_kdf_salt text default null,
  p_wrapped_key text default null,
  p_wrapped_iv text default null,
  p_auth_token text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room_id uuid;
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

  insert into rooms (owner_id, name, kdf_salt, wrapped_room_key, wrapped_key_iv, auth_verifier_hash, status)
  values (
    auth.uid(),
    trim(p_name),
    p_kdf_salt,
    p_wrapped_key,
    p_wrapped_iv,
    case when p_auth_token is not null then crypt(p_auth_token, gen_salt('bf', 10)) else null end,
    'pending_payment'
  )
  returning id into v_room_id;

  insert into room_members (room_id, user_id, role) values (v_room_id, auth.uid(), 'owner')
  on conflict (room_id, user_id) do update set role = 'owner';

  insert into room_orders (room_id, user_id, duration_months, amount_usd, tx_hash, status)
  values (v_room_id, auth.uid(), p_duration, p_duration * 1.00, v_clean_tx, 'pending')
  returning id into v_order_id;

  return jsonb_build_object('room_id', v_room_id, 'order_id', v_order_id);
end $$;

create or replace function public.submit_order(p_room_id uuid, p_duration int, p_tx_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from rooms where id = p_room_id and owner_id = auth.uid()) then
    raise exception 'Not your room';
  end if;
  insert into room_orders (room_id, user_id, duration_months, amount_usd, tx_hash)
  values (p_room_id, auth.uid(), p_duration, p_duration * 1.00, lower(trim(p_tx_hash)))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.get_room_kdf_salt(p_room_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select kdf_salt from rooms where id = p_room_id and status = 'active' and expires_at > now()
$$;

create or replace function public.verify_room_password(p_room_id uuid, p_auth_token text)
returns table (out_kdf_salt text, out_wrapped_key text, out_wrapped_iv text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'auth required'; end if;
  if (select count(*) from room_auth_attempts where room_id = p_room_id and user_id = v_user
        and attempted_at > now() - interval '1 minute') >= 5
     or (select count(*) from room_auth_attempts where room_id = p_room_id
        and attempted_at > now() - interval '10 minutes') >= 30 then
    raise exception 'rate_limited';
  end if;

  select r.auth_verifier_hash into v_hash from rooms r
   where r.id = p_room_id and r.status = 'active' and r.expires_at > now();
  if v_hash is null then return; end if;

  if v_hash <> crypt(p_auth_token, v_hash) then
    insert into room_auth_attempts (user_id, room_id) values (v_user, p_room_id);
    return;
  end if;

  insert into room_members (room_id, user_id) values (p_room_id, v_user)
  on conflict (room_id, user_id) do update set last_active_at = now();

  return query select r.kdf_salt, r.wrapped_room_key, r.wrapped_key_iv from rooms r where r.id = p_room_id;
end $$;

create or replace function public.setup_room_e2ee(
  p_room_id uuid, p_kdf_salt text, p_wrapped_key text, p_wrapped_iv text, p_auth_token text
) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from rooms where id = p_room_id and owner_id = auth.uid()
                 and (status in ('unlocked_setup', 'pending_payment') or (status = 'active' and wrapped_room_key is null))) then
    raise exception 'Unauthorized or already initialised';
  end if;
  update rooms set kdf_salt = p_kdf_salt, wrapped_room_key = p_wrapped_key, wrapped_key_iv = p_wrapped_iv,
         auth_verifier_hash = crypt(p_auth_token, gen_salt('bf', 10)),
         status = case when expires_at is not null and expires_at > now() then 'active'::room_status else status end
   where id = p_room_id;
  insert into room_members (room_id, user_id, role) values (p_room_id, auth.uid(), 'owner')
  on conflict (room_id, user_id) do update set role = 'owner';
  return true;
end $$;

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

create or replace function public.mark_room_read(p_room_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_min timestamptz;
begin
  if not public.can_use_room(p_room_id) then raise exception 'Not a member of a live room'; end if;
  update room_members set last_read_at = now(), last_active_at = now()
   where room_id = p_room_id and user_id = auth.uid();
  select min(last_read_at) into v_min from room_members
   where room_id = p_room_id and last_active_at > now() - interval '7 days';
  update messages
     set read_by_all_at = now(),
         expires_at = least(now() + interval '24 hours', created_at + interval '7 days')
   where room_id = p_room_id and read_by_all_at is null and created_at <= v_min;
end $$;

create or replace function public.delete_message_media(p_message_id uuid) returns smallint
language plpgsql security definer set search_path = public as $$
declare v_count smallint;
begin
  update messages set media_deleted = true
   where id = p_message_id and media_count > 0 and not media_deleted and public.can_use_room(room_id)
   returning media_count into v_count;
  if v_count is null then raise exception 'Nothing to delete'; end if;
  return v_count;
end $$;

create or replace function public.approve_room_order(p_order_id uuid, p_admin_notes text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_months int; v_exp timestamptz;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select room_id, duration_months into v_room, v_months from room_orders
   where id = p_order_id and status in ('pending','held') for update;
  if v_room is null then raise exception 'Order not found or already processed'; end if;

  select expires_at into v_exp from rooms where id = v_room for update;
  v_exp := case when v_exp is null or v_exp < now() then now() else v_exp end + make_interval(months => v_months);

  update rooms set expires_at = v_exp,
    status = case when wrapped_room_key is not null then 'active'::room_status
                  else 'unlocked_setup'::room_status end
   where id = v_room;
  update room_orders set status = 'approved', admin_notes = p_admin_notes,
         reviewed_by = auth.uid(), reviewed_at = now() where id = p_order_id;
  return true;
end $$;

create or replace function public.set_order_status(p_order_id uuid, p_status order_status, p_admin_notes text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('held','rejected') then raise exception 'Use approve_room_order to approve'; end if;
  update room_orders set status = p_status, admin_notes = p_admin_notes,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_order_id and status in ('pending','held');
  return found;
end $$;

-- ---------- ROOM MEMBER MANAGEMENT ------------------------------------------
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

create or replace function public.get_room_message_count(p_room_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
begin
  return public.get_room_unread_count(p_room_id);
end;
$$;

create or replace function public.get_room_members(p_room_id uuid)
returns table (
  user_id uuid,
  display_name text,
  role member_role,
  nickname text,
  joined_at timestamptz
) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not (public.is_room_member(p_room_id) or public.is_room_admin_or_owner(p_room_id)) then
    raise exception 'Unauthorized to view room members';
  end if;

  insert into room_members (room_id, user_id, role)
  select id, owner_id, 'owner'::member_role
    from rooms
   where id = p_room_id
  on conflict (room_id, user_id) do nothing;

  return query
  select
    rm.user_id,
    coalesce(nullif(trim(p.display_name), ''), 'Anonymous')::text as display_name,
    rm.role,
    rm.nickname::text,
    rm.joined_at
  from room_members rm
  left join profiles p on p.id = rm.user_id
  where rm.room_id = p_room_id
  order by
    case rm.role
      when 'owner' then 1
      when 'admin' then 2
      when 'member' then 3
      when 'banned' then 4
      else 5
    end,
    rm.joined_at asc;
end $$;

grant execute on function public.get_room_kdf_salt(uuid), public.get_room_message_count(uuid) to anon, authenticated;

grant execute on function public.create_room(text), public.create_room_order(text,int,text,text,text,text,text),
  public.submit_order(uuid,int,text), public.verify_room_password(uuid,text),
  public.setup_room_e2ee(uuid,text,text,text,text),
  public.rotate_room_password(uuid,text,text,text,text,text),
  public.mark_room_read(uuid), public.delete_message_media(uuid),
  public.approve_room_order(uuid,text), public.set_order_status(uuid,order_status,text),
  public.is_room_admin_or_owner(uuid), public.set_member_role(uuid, uuid, member_role),
  public.set_member_nickname(uuid, uuid, text), public.add_member_by_uuid(uuid, text, member_role, text),
  public.get_room_members(uuid)
  to authenticated;

-- ---------- CRON-ONLY (service_role) -----------------------------------------
create or replace function public.list_purgeable_media(p_limit int default 500) returns text[]
language sql stable security definer set search_path = public, storage as $$
  select coalesce(array_agg(name), '{}') from (
    select o.name from storage.objects o
    left join public.messages m on m.id = public.try_uuid(split_part(o.name, '/', 2))
    left join public.rooms r    on r.id = public.try_uuid(split_part(o.name, '/', 1))
    where o.bucket_id = 'chat-media'
      and o.created_at < now() - interval '1 hour'
      and (m.id is null or m.media_deleted or m.expires_at <= now()
           or r.id is null or r.expires_at <= now())
    limit p_limit) x
$$;

create or replace function public.purge_db() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from messages where expires_at <= now();
  update rooms set status = 'expired' where status = 'active' and expires_at <= now();
  delete from room_auth_attempts where attempted_at < now() - interval '1 hour';
end $$;

revoke execute on function public.list_purgeable_media(int), public.purge_db() from public, anon, authenticated;
grant  execute on function public.list_purgeable_media(int), public.purge_db() to service_role;

-- ---------- STORAGE ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 27262976, array['application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = 27262976,
  allowed_mime_types = array['application/octet-stream'];

drop policy if exists media_select on storage.objects;
create policy media_select on storage.objects for select to authenticated using (
  bucket_id = 'chat-media'
  and (
    owner_id = auth.uid()::text
    or (
      public.can_use_room(public.try_uuid((storage.foldername(name))[1]))
      and exists (select 1 from public.messages m
                  where m.id = public.try_uuid((storage.foldername(name))[2])
                    and m.room_id = public.try_uuid((storage.foldername(name))[1])
                    and m.expires_at > now())
    )
  )
);

drop policy if exists media_insert on storage.objects;
create policy media_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'chat-media'
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(raw|thumb)-[0-9]\.enc$'
  and public.can_use_room(public.try_uuid((storage.foldername(name))[1]))
);

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete to authenticated using (
  bucket_id = 'chat-media'
  and (
    owner_id = auth.uid()::text
    or (
      public.can_use_room(public.try_uuid((storage.foldername(name))[1]))
      and exists (select 1 from public.messages m
                  where m.id = public.try_uuid((storage.foldername(name))[2])
                    and m.room_id = public.try_uuid((storage.foldername(name))[1])
                    and m.media_deleted)
    )
  )
);

-- ---------- REACTIONS --------------------------------------------------------
-- One emoji reaction per member per message. The emoji is plaintext (server-visible); message text stays E2EE.
create table if not exists message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  room_id    uuid not null references rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null check (emoji in ('👍','❤️','😂','😮','😢','🙏')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists idx_reactions_room on message_reactions(room_id);
alter table message_reactions enable row level security;
alter table message_reactions replica identity full;
grant select on message_reactions to authenticated;
drop policy if exists reactions_read on message_reactions;
create policy reactions_read on message_reactions for select to authenticated using (public.can_use_room(room_id));

create or replace function public.toggle_reaction(p_message_id uuid, p_emoji text) returns text
language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_old text;
begin
  select room_id into v_room from messages where id = p_message_id and expires_at > now();
  if v_room is null or not public.can_use_room(v_room) then raise exception 'Message not found'; end if;
  select emoji into v_old from message_reactions where message_id = p_message_id and user_id = auth.uid();
  if v_old = p_emoji then
    delete from message_reactions where message_id = p_message_id and user_id = auth.uid();
    return null;
  end if;
  insert into message_reactions(message_id, room_id, user_id, emoji) values (p_message_id, v_room, auth.uid(), p_emoji)
  on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
  return p_emoji;
end $$;
revoke execute on function public.toggle_reaction(uuid,text) from public, anon;
grant  execute on function public.toggle_reaction(uuid,text) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.message_reactions;
exception when duplicate_object then null;
end $$;

-- ---------- REALTIME ---------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

drop policy if exists realtime_room_read on realtime.messages;
create policy realtime_room_read on realtime.messages for select to authenticated using (
  public.can_use_room(public.try_uuid(split_part(realtime.topic(), ':', 2))));

drop policy if exists realtime_room_write on realtime.messages;
create policy realtime_room_write on realtime.messages for insert to authenticated with check (
  public.can_use_room(public.try_uuid(split_part(realtime.topic(), ':', 2))));
