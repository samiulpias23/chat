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
  const schema = fs.readFileSync('supabase/schema.sql', 'utf8').replace(/\r\n/g, '\n');
  const verify = schema.match(/create or replace function public\.verify_room_password[\s\S]*?end \$\$;/)[0];
  const push = schema.slice(schema.indexOf('-- ---------- PUSH NOTIFICATIONS'), schema.indexOf('-- ---------- REALTIME'));

  await client.connect();
  console.log('Connected to DB...');
  await client.query('begin');
  const { rowCount } = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'room_members' and column_name = 'unlocked_at'`
  );
  if (!rowCount) {
    await client.query('alter table room_members add column unlocked_at timestamptz');
    // Existing members joined by entering the password
    await client.query('update room_members set unlocked_at = joined_at');
  }
  await client.query(verify);
  await client.query(push);
  await client.query('commit');
  console.log('Push notifications schema installed.');
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
