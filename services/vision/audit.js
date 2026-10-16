import { listSessions, getSession } from './store.js';
import * as pageStore from './pageStore.js';
import { readOpsLogs } from './events.js';

/**
 * Collect failed/skipped/needs_input pages and coherence drops across sessions.
 */
export function collectDroppedItems(opts = {}) {
  const limit = opts.limit ?? 100;
  const sessionFilter = opts.sessionId;
  const sessions = sessionFilter
    ? [getSession(sessionFilter)].filter(Boolean)
    : listSessions();

  const items = [];

  for (const session of sessions) {
    for (const page of pageStore.listPages(session.id)) {
      if (['failed', 'skipped'].includes(page.status)) {
        items.push({
          kind: 'page',
          sessionId: session.id,
          sessionName: session.name,
          pageIndex: page.index,
          pageId: page.id,
          status: page.status,
          pageType: page.pageType || null,
          error: page.error || null,
          filename: page.filename || null,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
        });
      }
    }

    for (const ev of session.events || []) {
      if (
        ev.type === 'extract_truncated' ||
        ev.type === 'coherence_drop' ||
        ev.type === 'page_failed' ||
        ev.type === 'input_truncated'
      ) {
        items.push({
          kind: 'event',
          sessionId: session.id,
          sessionName: session.name,
          ...ev,
        });
      }
    }

    for (const fu of session.followUps || []) {
      if (fu.status !== 'resolved') {
        items.push({
          kind: 'follow_up',
          sessionId: session.id,
          sessionName: session.name,
          followUpId: fu.id,
          type: fu.type,
          message: fu.message,
          resolvedAt: fu.resolvedAt || null,
          createdAt: fu.createdAt || session.updatedAt,
        });
      }
    }
  }

  return {
    total: items.length,
    items: items
      .sort((a, b) => (b.ts || b.updatedAt || b.createdAt || 0) - (a.ts || a.updatedAt || a.createdAt || 0))
      .slice(0, limit),
  };
}

export function getSessionEvents(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  return {
    sessionId,
    sessionName: session.name,
    status: session.status,
    events: session.events || [],
    fileEvents: readOpsLogs({ sessionId, limit: 500 }),
  };
}

export function getOpsLogs(opts = {}) {
  const fromFiles = readOpsLogs(opts);
  const fromSessions = [];

  if (!opts.sessionId) {
    for (const s of listSessions().slice(0, 50)) {
      for (const ev of (s.events || []).slice(-20)) {
        fromSessions.push({ ...ev, sessionId: s.id, sessionName: s.name });
      }
    }
  }

  const merged = [...fromSessions, ...fromFiles]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, opts.limit ?? 200);

  return { total: merged.length, logs: merged };
}

/** The stored transcription of one page (what the model submitted and the validator accepted). */
export function getPageOcr(sessionId, pageIndex) {
  const session = getSession(sessionId);
  if (!session) return null;
  const page = pageStore.getPageByIndex(sessionId, pageIndex);
  if (!page) return { error: `Page ${pageIndex} not found`, totalPages: pageStore.statusCounts(sessionId).total };
  return {
    sessionId,
    pageIndex: page.index,
    status: page.status,
    pageType: page.pageType || null,
    filename: page.filename || null,
    source: page.source || null,
    error: page.error || null,
    transcription: pageStore.getResult(page.id),
  };
}
