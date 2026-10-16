/**
 * Library + extraction activity reports (uploads today, recent syncs).
 */
import { listSessions } from '../vision/store.js';
import { listBundles } from './store.js';

function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfDay(d = new Date()) {
  return startOfDay(d) + 86400000 - 1;
}

function parseSince(query) {
  if (!query) return startOfDay();
  const lower = String(query).toLowerCase();
  if (lower === 'today') return startOfDay();
  if (lower === 'yesterday') return startOfDay(new Date(Date.now() - 86400000));
  const days = parseInt(lower, 10);
  if (!Number.isNaN(days) && days > 0) return Date.now() - days * 86400000;
  const ts = Date.parse(query);
  if (!Number.isNaN(ts)) return ts;
  return startOfDay();
}

export function getLibraryActivity({ since = 'today', limit = 100 } = {}) {
  const sinceTs = parseSince(since);
  const untilTs = String(since).toLowerCase() === 'yesterday'
    ? endOfDay(new Date(Date.now() - 86400000))
    : Date.now();

  const sessions = listSessions()
    .filter((s) => {
      const t = s.updatedAt || s.createdAt || 0;
      return t >= sinceTs && t <= untilTs;
    })
    .map((s) => ({
      kind: 'session',
      id: s.id,
      name: s.name,
      status: s.status,
      questionCount: (s.questions || []).length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      libraryMeta: s.libraryMeta || null,
    }));

  const bundles = listBundles()
    .filter((b) => {
      const t = new Date(b.updated_at || b.created_at || 0).getTime();
      return t >= sinceTs && t <= untilTs;
    })
    .map((b) => ({
      kind: 'bundle',
      id: b.id,
      title: b.title || b.name,
      manufacturer: b.manufacturer,
      university: b.university,
      examType: b.examType,
      questionCount: b.question_count ?? (b.questions || []).length,
      updated_at: b.updated_at,
      created_at: b.created_at,
    }));

  const items = [...sessions, ...bundles]
    .sort((a, b) => {
      const ta = a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0;
      const tb = b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0;
      const tsa = typeof ta === 'number' ? ta : new Date(ta).getTime();
      const tsb = typeof tb === 'number' ? tb : new Date(tb).getTime();
      return tsb - tsa;
    })
    .slice(0, limit);

  const noAnswerCount = listBundles().reduce((acc, b) => {
    return acc + (b.questions || []).filter((q) => q.correct == null || q.correct === '').length;
  }, 0);

  return {
    since: new Date(sinceTs).toISOString(),
    until: new Date(untilTs).toISOString(),
    sessionsUploaded: sessions.length,
    bundlesUpdated: bundles.length,
    totalQuestionsInLibrary: listBundles().reduce(
      (n, b) => n + (b.question_count ?? (b.questions || []).length),
      0
    ),
    questionsMissingAnswers: noAnswerCount,
    items,
  };
}
