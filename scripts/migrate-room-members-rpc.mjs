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

  grant execute on function public.get_room_members(uuid) to authenticated;
  `;

  await client.query(sql);
  console.log('get_room_members RPC updated successfully with #variable_conflict use_column!');
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
