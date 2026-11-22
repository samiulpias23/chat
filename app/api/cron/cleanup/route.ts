import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // Verify CRON_SECRET bearer token
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabaseAdmin = createAdminClient();

    // 1. Fetch purgeable storage paths (expired, deleted, or orphan blobs)
    const { data: paths, error: listErr } = await supabaseAdmin.rpc('list_purgeable_media', {
      p_limit: 500,
    });

    if (listErr) throw listErr;

    let removedCount = 0;
    if (paths && paths.length > 0) {
      // Chunk removals into batches of 100
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        const { error: removeErr } = await supabaseAdmin.storage.from('chat-media').remove(chunk);
        if (removeErr) {
          console.error('Storage purge error:', removeErr);
          throw removeErr; // Stop here; database rows still point to remaining files
        }
        removedCount += chunk.length;
      }
    }

    // 2. Database purge: delete expired messages & auto-expire rooms
    const { error: purgeErr } = await supabaseAdmin.rpc('purge_db');
    if (purgeErr) throw purgeErr;

    return NextResponse.json({
      success: true,
      purged_media_count: removedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('Cron cleanup failed:', err);
    return NextResponse.json({ error: err.message || 'Cron cleanup failed' }, { status: 500 });
  }
}
