import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import * as pageStore from './pageStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataRoot() {
  const env = process.env.DATA_DIR || process.env.PASTQ_DATA_DIR;
  if (env) return path.resolve(env);
  return path.join(__dirname, '../../data');
}

const DATA_DIR = getDataRoot();
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

for (const dir of [DATA_DIR, SESSIONS_DIR, PAGES_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, JSON.stringify({}));

/** Write via a temp file + rename so a crash never leaves a half-written file. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function sessionPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session id');
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function pageDir(sessionId) {
  const dir = path.join(PAGES_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getJobs() {
  return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
}

function saveJobs(jobs) {
  writeAtomic(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function createSession({ id, name, icon, subjectHint, ownerKey }) {
  const session = {
    id,
    // Extraction work and question content remain on the VPS. This is a
    // one-way ownership HMAC, not a Supabase user id or profile datum.
    ownerKey: ownerKey || null,
    name: name || 'New Material',
    icon: icon || '📖',
    subjectHint: subjectHint || null,
    pipeline: 'v3',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Pages live in SQLite (pageStore.js), not in this file.
    questions: [],
    answerKeys: [],
    groups: [],
    followUps: [],
    outline: null,
    questionIdByKey: {},
    adjudications: {},
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    progress: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0 },
    events: [],
  };
  saveSession(session);
  return session;
}

function getSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  const session = JSON.parse(fs.readFileSync(p, 'utf8'));
  // One-time move of pages from older session files into the page store.
  if (Array.isArray(session.pages)) {
    const known = new Set(pageStore.listPages(id).map((pg) => pg.id));
    const dir = pageDir(id);
    pageStore.addPages(id, session.pages.filter((pg) => !known.has(pg.id)).map((pg) => {
      let textPath = pg.textPath || null;
      // Old text-only pages kept their content inline; keep it as a text page.
      if (!pg.imagePath && !textPath && pg.ocrMarkdown) {
        textPath = path.join(dir, `page-${String(pg.index).padStart(6, '0')}.txt`);
        fs.writeFileSync(textPath, pg.ocrMarkdown);
      }
      // Earlier pipelines' results are not reused: every page is transcribed again.
      return { ...pg, status: 'pending', textPath, source: pg.source || (pg.imagePath ? 'image' : 'text') };
    }));
    delete session.pages;
    session.pipeline = session.pipeline === 'v3' ? 'v3' : 'migrated';
    saveSession(session);
  }
  return session;
}

function saveSession(session) {
  session.updatedAt = Date.now();
  writeAtomic(sessionPath(session.id), JSON.stringify(session, null, 2));
  return session;
}

function listSessions() {
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      } catch (err) {
        console.error(`[store] unreadable session file ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function deleteSession(id) {
  pageStore.deleteSessionPages(id);
  fs.rmSync(sessionPath(id), { force: true });
  fs.rmSync(path.join(PAGES_DIR, id), { recursive: true, force: true });
}

function progressOf(sessionId) {
  const c = pageStore.statusCounts(sessionId);
  return { total: c.total, done: c.done, failed: c.failed, skipped: c.skipped, pending: c.pending + c.processing, processing: c.processing, questionsFound: c.questions };
}

function updateProgress(session) {
  session.progress = progressOf(session.id);
  return session.progress;
}

const PUBLIC_PAGE_LIMIT = 500;

function publicPages(sessionId) {
  let pages = pageStore.listPages(sessionId);
  if (pages.length > PUBLIC_PAGE_LIMIT) pages = pages.filter((p) => p.status !== 'done' && p.status !== 'skipped').slice(0, PUBLIC_PAGE_LIMIT);
  return pages.map((p) => ({
    id: p.id, index: p.index, status: p.status, retryCount: p.attempts, pageType: p.pageType, legibility: p.legibility,
    error: p.error, filename: p.filename, source: p.source, turns: p.turns, inspections: p.inspections, questions: p.questions,
  }));
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    name: session.name,
    icon: session.icon,
    status: session.status,
    approvedAt: session.approvedAt || null,
    pausedReason: session.pausedReason || null,
    model: session.model || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    progress: progressOf(session.id),
    ingest: session.ingest || null,
    outline: session.outline
      ? {
        organizedBy: session.outline.organizedBy,
        documentTitle: session.outline.documentTitle,
        sections: session.outline.sections.map(({ id, title, kind, pageStart, pageEnd, year, topic, subject }) => ({ id, title, kind, pageStart, pageEnd, year, topic, subject })),
      }
      : null,
    groups: session.groups,
    followUps: (session.followUps || []).filter((f) => f.status !== 'resolved'),
    allFollowUps: session.followUps || [],
    questions: session.questions,
    answerKeyCount: (session.answerKeys || []).length,
    // Large uploads list only pages that need attention or are in flight.
    pages: publicPages(session.id),
    cost: session.cost,
  };
}

export {
  getDataRoot,
  DATA_DIR,
  JOBS_FILE,
  PAGES_DIR,
  getJobs,
  saveJobs,
  createSession,
  getSession,
  saveSession,
  listSessions,
  deleteSession,
  updateProgress,
  publicSession,
  pageDir,
};
