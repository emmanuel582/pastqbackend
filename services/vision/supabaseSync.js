/**
 * Supabase sync for PastQ vision pipeline.
 *
 * Solves the visibility bug: extracted questions were only stored in
 * server-local JSON files. This module syncs completed session data to
 * Supabase `library_bundles` so ALL users can see them immediately.
 *
 * Uses upsert (ON CONFLICT DO UPDATE) for idempotent progressive sync.
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  // Prefer service role key for server-side writes (bypasses RLS); fall back to anon key
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    console.warn('[supabase-sync] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — sync disabled');
    return null;
  }

  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  return _supabase;
}

const unknownColumns = new Set();

/**
 * Sync a session's extracted data to Supabase `library_bundles`.
 * Called progressively after each page completes — users see questions appearing in real-time.
 * Dynamically adapts to whatever schema columns exist in the database.
 *
 * @param {Object} session - The full session object from store
 * @returns {Promise<{synced: boolean, error?: string}>}
 */
async function syncSessionToSupabase(session) {
  const supabase = getSupabase();
  if (!supabase) return { synced: false, error: 'Supabase not configured' };

  try {
    const payload = {
      id: session.id,
      title: session.name || 'Untitled Material',
      name: session.name || 'Untitled Material',
      icon: session.icon || '📖',
      status: session.status || 'processing',
      questions: session.questions || [],
      groups: session.groups || [],
      subject: session.memory?.activeSubject || session.subjectHint || null,
      question_count: (session.questions || []).length,
      cost: session.cost || null,
      progress: session.progress || null,
      follow_ups: (session.followUps || []).filter((f) => f.status !== 'resolved'),
      answer_key_count: (session.answerKeys || []).length,
      created_at: session.createdAt ? new Date(session.createdAt).toISOString() : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    for (const col of unknownColumns) {
      delete payload[col];
    }

    let attempts = 0;
    while (attempts < 15) {
      attempts++;
      const { error } = await supabase
        .from('library_bundles')
        .upsert(payload, { onConflict: 'id' });

      if (!error) {
        return { synced: true };
      }

      // If table doesn't exist, log once and continue — don't crash the pipeline
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        console.warn('[supabase-sync] library_bundles table does not exist — run migration first');
        return { synced: false, error: 'Table not found' };
      }

      // Adaptively detect columns that do not exist in the database schema cache
      const missingColMatch = error.message?.match(/Could not find the '([^']+)' column/i);
      if (missingColMatch && missingColMatch[1] && payload.hasOwnProperty(missingColMatch[1])) {
        const col = missingColMatch[1];
        unknownColumns.add(col);
        delete payload[col];
        continue;
      }

      console.error('[supabase-sync] upsert failed:', error.message);
      return { synced: false, error: error.message };
    }

    return { synced: false, error: 'Max schema fallback attempts reached' };
  } catch (err) {
    console.error('[supabase-sync] unexpected error:', err.message || err);
    return { synced: false, error: err.message || String(err) };
  }
}

/**
 * On server startup, sync any sessions that completed while Supabase was unreachable.
 * Called from boot sequence.
 *
 * @param {Function} listSessionsFn - Function that returns all sessions
 */
async function syncAllPendingSessions(listSessionsFn) {
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    const sessions = listSessionsFn();
    let synced = 0;
    for (const session of sessions) {
      if (
        session.questions?.length > 0 &&
        ['completed', 'completed_with_errors', 'needs_input'].includes(session.status)
      ) {
        const result = await syncSessionToSupabase(session);
        if (result.synced) synced++;
      }
    }
    if (synced > 0) {
      console.log(`[supabase-sync] startup: synced ${synced} pending sessions`);
    }
  } catch (err) {
    console.error('[supabase-sync] startup sync failed:', err.message || err);
  }
}

export { syncSessionToSupabase, syncAllPendingSessions };
