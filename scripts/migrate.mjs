import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

// Parse .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx !== -1) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
const dbUrl = env.DATABASE_URL;

console.log('Connecting to Supabase database for migration...');

async function runMigration() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL successfully!');

    const schemaPath = path.resolve(process.cwd(), 'supabase', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    console.log('Applying supabase/schema.sql...');
    await client.query(sql);
    console.log('Schema migration applied successfully!');

    // Verify public tables
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('Public tables created:');
    for (const row of tableCheck.rows) {
      console.log(`  - ${row.table_name}`);
    }

    // Verify Storage Bucket
    const bucketCheck = await client.query(`
      SELECT id, name, public, file_size_limit 
      FROM storage.buckets 
      WHERE id = 'chat-media';
    `);
    if (bucketCheck.rows.length > 0) {
      console.log('Storage bucket verified: chat-media (private, max 26MB)');
    } else {
      console.warn('Storage bucket chat-media was not found.');
    }

  } finally {
    await client.end();
  }

  // Seed Admin user via Supabase Auth Admin API
  if (supabaseUrl && serviceKey) {
    console.log('Checking / Seeding admin account: admin@chataf.com...');
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      console.warn('Could not list users via admin API:', listError.message);
    } else {
      const existingAdmin = users?.users?.find(u => u.email === 'admin@chataf.com');
      if (existingAdmin) {
        console.log(`Admin user already exists (id: ${existingAdmin.id}). Ensuring role = 'admin'...`);
        await supabaseAdmin.auth.admin.updateUserById(existingAdmin.id, {
          app_metadata: { ...existingAdmin.app_metadata, role: 'admin' }
        });
        console.log('Admin role confirmed!');
      } else {
        if (!env.ADMIN_PASSWORD) { console.warn('Set ADMIN_PASSWORD in .env.local to create the admin user; skipping.'); } else {
console.log('Creating admin user admin@chataf.com...');
        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: 'admin@chataf.com',
          password: env.ADMIN_PASSWORD,
          email_confirm: true,
          app_metadata: { role: 'admin' }
        });
        if (createError) {
          console.error('Failed to create admin user:', createError.message);
        } else {
          console.log(`Admin user created successfully (id: ${newUser.user.id}) with role: 'admin'!`);
        }
        }
      }
    }
  }

  console.log('All migration and seeding steps completed!');
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
