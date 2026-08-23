/**
 * Sync completed extraction sessions to VPS library store (primary).
 * Supabase sync is optional via LIBRARY_SYNC_SUPABASE env flag.
 */
import { saveSession } from '../vision/store.js';
import { classifyLibrarySession } from '../vision/libraryClassifier.js';
import { upsertSessionToLibrary } from './store.js';
import { syncSessionToSupabase } from '../vision/supabaseSync.js';

const SYNC_STATUSES = new Set(['completed', 'completed_with_errors']);

function shouldSyncToLibrary(session) {
  if (!session) return false;
  if (!SYNC_STATUSES.has(session.status)) return false;
  if (!(session.questions || []).length) return false;
  return true;
}

/**
 * Classify + persist session to library store. Returns sync result.
 */
export async function syncSessionToLibrary(session, context = {}) {
  if (!shouldSyncToLibrary(session)) {
    return { synced: false, reason: 'not_ready' };
  }

  try {
    if (!session.libraryMeta) {
      session.libraryMeta = await classifyLibrarySession(session, context);
      saveSession(session);
    }

    const { bundle } = upsertSessionToLibrary(session, session.libraryMeta);

    let supabaseResult = { synced: false, skipped: true };
    if (process.env.LIBRARY_SYNC_SUPABASE === 'true') {
      supabaseResult = await syncSessionToSupabase(session);
    }

    console.log(
      `[library-sync] ${session.id} → bundle ${bundle.id} (${bundle.manufacturer}, ${bundle.questions.length} Q)`
    );

    return {
      synced: true,
      bundleId: bundle.id,
      libraryMeta: session.libraryMeta,
      supabase: supabaseResult,
    };
  } catch (err) {
    console.error('[library-sync] error:', err.message);
    return { synced: false, error: err.message };
  }
}

export async function syncAllSessionsToLibrary(listSessionsFn) {
  const sessions = listSessionsFn();
  let synced = 0;
  let failed = 0;

  for (const session of sessions) {
    if (!shouldSyncToLibrary(session)) continue;
    const result = await syncSessionToLibrary(session);
    if (result.synced) synced++;
    else failed++;
  }

  return { synced, failed, total: sessions.length };
}
