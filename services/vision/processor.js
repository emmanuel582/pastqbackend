/**
 * Session orchestration: per-session locking, follow-ups, ingest, and the
 * worker entry point. All extraction runs through the vision pipeline
 * (pipeline.js); there is no second, heuristic path.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getSession, saveSession, pageDir } from './store.js';
import * as pageStore from './pageStore.js';
import { appendSessionEvent } from './events.js';
import { runVisionWorker } from './pipeline.js';
import { rasterizePdfToPages } from './pdf.js';

const TEXT_PAGE_CHARS = Number(process.env.VISION_TEXT_PAGE_CHARS || 12000);
const INGEST_FLUSH_EVERY = 10;

const activeWorkers = new Set();
const abortedSessions = new Set();

// ── Per-session mutex (serialises read-modify-write of the session file) ────
class SessionMutex {
  constructor() { this._chain = Promise.resolve(); }
  acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const prev = this._chain;
    this._chain = next;
    return prev.then(() => release);
  }
}
const sessionLocks = new Map();

async function withSessionLock(sessionId, fn) {
  if (!sessionLocks.has(sessionId)) sessionLocks.set(sessionId, new SessionMutex());
  const release = await sessionLocks.get(sessionId).acquire();
  try {
    const session = getSession(sessionId);
    if (!session) return null;
    const result = await fn(session);
    saveSession(session);
    return result;
  } finally {
    release();
  }
}

// The running worker notices the abort between steps and exits; its `finally`
// releases the slot, so a later resume never runs alongside it.
function abortSession(sessionId) {
  abortedSessions.add(sessionId);
  console.log(`[vision] Session ${sessionId} cancelled`);
}

function abortAllSessions() {
  for (const id of activeWorkers) abortedSessions.add(id);
}

function mergeFollowUps(session, incoming) {
  session.followUps = session.followUps || [];
  for (const f of incoming || []) {
    if (!f?.message) continue;
    const id = f.id || `fu-${crypto.randomUUID()}`;
    const existing = session.followUps.find((x) => x.id === id);
    if (existing) {
      if (existing.status !== 'resolved') Object.assign(existing, { message: f.message, meta: f.meta || existing.meta });
      continue;
    }
    session.followUps.push({ id, type: f.type || 'general', status: 'open', message: f.message, meta: f.meta || {}, pageId: f.pageId || null, createdAt: Date.now() });
  }
}

// ── Pasted text → text pages ────────────────────────────────────────────────

/** Split text into page-sized chunks on line boundaries (size bound only). */
function splitTextIntoPages(text) {
  const lines = String(text).split('\n');
  const pages = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > TEXT_PAGE_CHARS) {
      pages.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) pages.push(current);
  return pages;
}

/** Write pasted text as text pages and register them; returns the page count. */
function addTextPages(sessionId, text) {
  const dir = pageDir(sessionId);
  const start = pageStore.nextIndex(sessionId);
  const pages = splitTextIntoPages(text).map((chunk, i) => {
    const index = start + i;
    const textPath = path.join(dir, `page-${String(index).padStart(6, '0')}.txt`);
    fs.writeFileSync(textPath, chunk);
    return { id: crypto.randomUUID(), index, status: 'pending', filename: `text-part-${i + 1}`, textPath, source: 'text' };
  });
  pageStore.addPages(sessionId, pages);
  return pages.length;
}

// ── PDF ingest ──────────────────────────────────────────────────────────────

/**
 * Rasterise a stored PDF into image pages (parallel workers). Pages are
 * registered in small batches and the worker starts as soon as pages exist,
 * so large PDFs begin transcribing while the rest are still rendering.
 */
async function ingestPdfIntoSession(sessionId, pdfPath) {
  const startIndex = pageStore.nextIndex(sessionId);
  await withSessionLock(sessionId, (s) => {
    s.status = 'processing';
    s.ingest = { status: 'running', pagesDone: 0, startedAt: Date.now(), file: path.basename(pdfPath) };
  });
  let buffered = [];
  let total = 0;
  const flush = () => {
    if (!buffered.length) return;
    pageStore.addPages(sessionId, buffered);
    buffered = [];
    kickoffSession(sessionId);
  };
  try {
    await rasterizePdfToPages(sessionId, pdfPath, {
      startIndex,
      onPage: async (pg) => {
        buffered.push({ id: crypto.randomUUID(), index: pg.index, status: 'pending', filename: `pdf-page-${pg.pdfPage}`, imagePath: pg.imagePath, width: pg.width, height: pg.height, source: 'pdf' });
        total += 1;
        if (buffered.length >= INGEST_FLUSH_EVERY) flush();
      },
    });
    flush();
    await withSessionLock(sessionId, (s) => {
      s.ingest = { ...s.ingest, status: 'done', pagesDone: total, finishedAt: Date.now() };
      appendSessionEvent(s, { type: 'pdf_ingested', pages: total });
    });
  } catch (err) {
    flush();
    await withSessionLock(sessionId, (s) => {
      s.ingest = { ...s.ingest, status: 'failed', pagesDone: total, error: err.message };
      mergeFollowUps(s, [{ id: `pdf-fail-${sessionId}`, type: 'pdf_failed', message: `The PDF could not be fully read after ${total} page(s): ${err.message}. Re-export or re-scan the PDF and upload it again.` }]);
      if (!pageStore.statusCounts(sessionId).total) s.status = 'failed';
    });
    throw err;
  } finally {
    kickoffSession(sessionId);
  }
  return total;
}

// ── Migration of sessions created by earlier pipelines ──────────────────────

/**
 * getSession() already moved old pages into the page store. Here: clear the
 * earlier outputs, and re-read the original PDF as images when the old
 * session only kept OCR text.
 */
async function migrateLegacySession(sessionId) {
  const session = getSession(sessionId);
  if (session.pipeline === 'v3') return false;
  const sourcePdf = path.join(pageDir(sessionId), 'source.pdf');
  const pages = pageStore.listPages(sessionId);
  const reingest = !pages.some((p) => p.imagePath) && fs.existsSync(sourcePdf);
  if (reingest) pageStore.deleteSessionPages(sessionId);
  pageStore.clearSessionResults(sessionId);
  await withSessionLock(sessionId, (s) => {
    Object.assign(s, { pipeline: 'v3', questions: [], groups: [], answerKeys: [], outline: null, questionIdByKey: {}, adjudications: {} });
    appendSessionEvent(s, { type: 'migrated', via: reingest ? 'source_pdf' : 'pages' });
  });
  if (reingest) {
    ingestPdfIntoSession(sessionId, sourcePdf).catch((err) => console.error(`[vision] migration ingest failed for ${sessionId}: ${err.message}`));
    return true;
  }
  return false;
}

// ── Worker entry ────────────────────────────────────────────────────────────

async function runSessionWorker(sessionId) {
  if (activeWorkers.has(sessionId)) return;
  activeWorkers.add(sessionId);
  abortedSessions.delete(sessionId);
  try {
    if (!getSession(sessionId)) return;
    if (await migrateLegacySession(sessionId)) return; // ingest restarts the worker
    await runVisionWorker(sessionId, { withSessionLock, mergeFollowUps, isAborted: (id) => abortedSessions.has(id) });
  } finally {
    activeWorkers.delete(sessionId);
  }
}

function kickoffSession(sessionId) {
  setImmediate(() => {
    runSessionWorker(sessionId).catch(async (err) => {
      console.error(`[vision] worker crashed for ${sessionId}:`, err);
      await withSessionLock(sessionId, (s) => {
        s.status = 'needs_attention';
        mergeFollowUps(s, [{ id: 'worker-crash', type: 'worker_error', message: `Processing stopped unexpectedly: ${err.message}. Resume to continue from the last saved page.` }]);
      }).catch(() => {});
    });
  });
}

/** After a server restart, continue every session that still has queued pages. */
function resumeInterruptedSessions() {
  // Only sessions that were mid-run: migrated older sessions also have queued
  // pages, but they re-run only when someone resumes them (it costs credit).
  for (const id of pageStore.sessionsWithPendingWork()) {
    if (getSession(id)?.status === 'processing') kickoffSession(id);
  }
}

export {
  resumeInterruptedSessions,
  withSessionLock,
  mergeFollowUps,
  kickoffSession,
  ingestPdfIntoSession,
  addTextPages,
  splitTextIntoPages,
  runSessionWorker,
  abortSession,
  abortAllSessions,
};
