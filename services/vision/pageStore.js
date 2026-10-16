/**
 * Page and result state in SQLite (node:sqlite, WAL mode).
 *
 * Page status changes many times per page; at tens of thousands of pages that
 * cannot live in a session JSON file that is rewritten on every change. Each
 * update here is one small indexed row write, atomic and crash-safe.
 */
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { getDataRoot } from './store.js';

let db = null;
let dbFile = null;

function open() {
  const file = path.join(getDataRoot(), 'pastq-pages.db');
  if (db && dbFile === file) return db;
  db = new DatabaseSync(file);
  dbFile = file;
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pages (
      page_id     TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      idx         INTEGER NOT NULL,
      status      TEXT NOT NULL,
      source      TEXT,
      filename    TEXT,
      image_path  TEXT,
      text_path   TEXT,
      width       INTEGER,
      height      INTEGER,
      page_type   TEXT,
      legibility  TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      turns       INTEGER NOT NULL DEFAULT 0,
      inspections INTEGER NOT NULL DEFAULT 0,
      questions   INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pages_session_idx ON pages (session_id, idx);
    CREATE INDEX IF NOT EXISTS pages_session_status ON pages (session_id, status);
    CREATE TABLE IF NOT EXISTS results (
      page_id    TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS results_session ON results (session_id);
  `);
  return db;
}

const COLUMNS = {
  index: 'idx', status: 'status', source: 'source', filename: 'filename', imagePath: 'image_path', textPath: 'text_path',
  width: 'width', height: 'height', pageType: 'page_type', legibility: 'legibility', attempts: 'attempts',
  error: 'error', turns: 'turns', inspections: 'inspections', questions: 'questions',
};

function rowToPage(r) {
  return {
    id: r.page_id, sessionId: r.session_id, index: r.idx, status: r.status, source: r.source, filename: r.filename,
    imagePath: r.image_path, textPath: r.text_path, width: r.width, height: r.height, pageType: r.page_type,
    legibility: r.legibility, attempts: r.attempts, error: r.error, turns: r.turns, inspections: r.inspections,
    questions: r.questions,
  };
}

function addPages(sessionId, pages) {
  const d = open();
  const stmt = d.prepare(`INSERT INTO pages (page_id, session_id, idx, status, source, filename, image_path, text_path, width, height, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  d.exec('BEGIN');
  try {
    for (const p of pages) stmt.run(p.id, sessionId, p.index, p.status || 'pending', p.source || null, p.filename || null, p.imagePath || null, p.textPath || null, p.width || null, p.height || null, Date.now());
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function listPages(sessionId) {
  return open().prepare('SELECT * FROM pages WHERE session_id = ? ORDER BY idx').all(sessionId).map(rowToPage);
}

function getPage(pageId) {
  const r = open().prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId);
  return r ? rowToPage(r) : null;
}

function getPageByIndex(sessionId, index) {
  const r = open().prepare('SELECT * FROM pages WHERE session_id = ? AND idx = ?').get(sessionId, index);
  return r ? rowToPage(r) : null;
}

function updatePage(pageId, fields) {
  const sets = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!COLUMNS[k]) throw new Error(`Unknown page field ${k}`);
    sets.push(`${COLUMNS[k]} = ?`);
    values.push(v ?? null);
  }
  sets.push('updated_at = ?');
  values.push(Date.now(), pageId);
  open().prepare(`UPDATE pages SET ${sets.join(', ')} WHERE page_id = ?`).run(...values);
}

/** Atomically claim up to `limit` pending pages (lowest index first) for processing. */
function claimPending(sessionId, limit) {
  const d = open();
  d.exec('BEGIN IMMEDIATE');
  try {
    const rows = d.prepare("SELECT * FROM pages WHERE session_id = ? AND status = 'pending' ORDER BY idx LIMIT ?").all(sessionId, limit);
    const upd = d.prepare("UPDATE pages SET status = 'processing', updated_at = ? WHERE page_id = ?");
    for (const r of rows) upd.run(Date.now(), r.page_id);
    d.exec('COMMIT');
    return rows.map((r) => ({ ...rowToPage(r), status: 'processing' }));
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function requeue(sessionId, statuses) {
  const marks = statuses.map(() => '?').join(',');
  return open().prepare(`UPDATE pages SET status = 'pending', error = NULL, attempts = 0, updated_at = ? WHERE session_id = ? AND status IN (${marks})`).run(Date.now(), sessionId, ...statuses).changes;
}

function statusCounts(sessionId) {
  const counts = { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, processing: 0, questions: 0 };
  for (const r of open().prepare('SELECT status, COUNT(*) AS n, SUM(questions) AS q FROM pages WHERE session_id = ? GROUP BY status').all(sessionId)) {
    counts[r.status] = r.n;
    counts.total += r.n;
    counts.questions += r.q || 0;
  }
  return counts;
}

/** Make room for `count` pages at `position` (later pages move down). */
function shiftIndices(sessionId, position, count) {
  const d = open();
  // Two steps avoid transient duplicate indices.
  d.prepare('UPDATE pages SET idx = -(idx + ?) - 1 WHERE session_id = ? AND idx >= ?').run(count, sessionId, position);
  d.prepare('UPDATE pages SET idx = -idx - 1 WHERE session_id = ? AND idx < 0').run(sessionId);
}

function nextIndex(sessionId) {
  const r = open().prepare('SELECT MAX(idx) AS m FROM pages WHERE session_id = ?').get(sessionId);
  return r.m == null ? 0 : r.m + 1;
}

function saveResult(sessionId, pageId, result) {
  open().prepare('INSERT INTO results (page_id, session_id, json) VALUES (?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET json = excluded.json').run(pageId, sessionId, JSON.stringify(result));
}

function getResult(pageId) {
  const r = open().prepare('SELECT json FROM results WHERE page_id = ?').get(pageId);
  return r ? JSON.parse(r.json) : null;
}

function deleteResult(pageId) {
  open().prepare('DELETE FROM results WHERE page_id = ?').run(pageId);
}

/** Results of finished pages, keyed by page id. */
function loadResults(sessionId) {
  const map = new Map();
  for (const r of open().prepare("SELECT r.page_id, r.json FROM results r JOIN pages p ON p.page_id = r.page_id WHERE r.session_id = ? AND p.status IN ('done','skipped')").all(sessionId)) {
    map.set(r.page_id, JSON.parse(r.json));
  }
  return map;
}

function clearSessionResults(sessionId) {
  open().prepare('DELETE FROM results WHERE session_id = ?').run(sessionId);
}

function deleteSessionPages(sessionId) {
  const d = open();
  d.prepare('DELETE FROM results WHERE session_id = ?').run(sessionId);
  d.prepare('DELETE FROM pages WHERE session_id = ?').run(sessionId);
}

/** Sessions that still have work queued (used to resume after a restart). */
function sessionsWithPendingWork() {
  return open().prepare("SELECT DISTINCT session_id FROM pages WHERE status IN ('pending','processing')").all().map((r) => r.session_id);
}

/** After a crash, pages left 'processing' were never finished. */
function resetProcessing(sessionId) {
  return open().prepare("UPDATE pages SET status = 'pending', updated_at = ? WHERE session_id = ? AND status = 'processing'").run(Date.now(), sessionId).changes;
}

export {
  addPages, listPages, getPage, getPageByIndex, updatePage, claimPending, requeue, statusCounts, shiftIndices, nextIndex,
  saveResult, getResult, deleteResult, loadResults, clearSessionResults, deleteSessionPages, sessionsWithPendingWork, resetProcessing,
};
