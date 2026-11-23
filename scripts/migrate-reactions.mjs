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
`;
  await client.query(sql);
  console.log('message_reactions + toggle_reaction installed.');
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
