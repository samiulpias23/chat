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
  await client.query(`
    create or replace function public.get_room_message_count(p_room_id uuid)
    returns int
    language sql stable security definer set search_path = public as $$
      select coalesce(count(*)::int, 0)
        from messages
       where room_id = p_room_id
         and (expires_at is null or expires_at > now());
    $$;
    grant execute on function public.get_room_message_count(uuid) to anon, authenticated;
  `);
  console.log('SUCCESS: Updated get_room_message_count to check (expires_at is null or expires_at > now())');
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
