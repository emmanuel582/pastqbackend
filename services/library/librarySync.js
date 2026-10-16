/**
 * Sync completed extraction sessions to the Hostinger VPS library store.
 */
import { saveSession } from '../vision/store.js';
import { classifyLibrarySession } from '../vision/libraryClassifier.js';
import { TAXONOMY_VERSION } from '../vision/educationTaxonomy.js';
import { upsertSessionToLibrary } from './store.js';

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
    if (!session.libraryMeta || session.libraryMeta.taxonomyVersion !== TAXONOMY_VERSION) {
      session.libraryMeta = await classifyLibrarySession(session, context);
      saveSession(session);
    }

    // Apply the model's canonical subject names so one subject is one shelf.
    const canonical = session.libraryMeta.canonicalSubjects || {};
    for (const q of session.questions) if (canonical[q.subject]) q.subject = canonical[q.subject];
    saveSession(session);

    const { bundle } = upsertSessionToLibrary(session, session.libraryMeta);

    console.log(
      `[library-sync] ${session.id} → bundle ${bundle.id} (${bundle.manufacturer}, ${bundle.questions.length} Q)`
    );

    return {
      synced: true,
      bundleId: bundle.id,
      libraryMeta: session.libraryMeta,
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
