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
  grant select (id, owner_id, name, status, expires_at, created_at) on rooms to anon, authenticated;

  drop policy if exists rooms_read on rooms;
  create policy rooms_read on rooms for select to anon, authenticated using (true);
  `;

  await client.query(sql);
  console.log('Granted room directory read access to anon & authenticated successfully!');
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
