/**
 * Copy the finished pages of a running extraction into another data dir as a
 * preview session, so it can be assembled and viewed in the app while the
 * original run continues.
 *
 *   DATA_DIR=<target data dir> node scripts/import-preview-session.mjs <source data dir> <session id> [--with-output]
 *
 * --with-output copies the finished, assembled result as is and publishes it
 * to the target library (no model calls); without it, the session is reset so
 * the final pass runs again in the target.
 *
 * Only pages already transcribed (done/skipped) are copied, with their saved
 * results; figure files are copied so their URLs resolve.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const [sourceDir, sessionId, flag] = process.argv.slice(2);
const withOutput = flag === '--with-output';
if (!sourceDir || !sessionId) throw new Error('usage: import-preview-session.mjs <source data dir> <session id>');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to the target data dir');

const { getSession, saveSession, pageDir } = await import('../services/vision/store.js');
const pageStore = await import('../services/vision/pageStore.js');

const src = new DatabaseSync(path.join(sourceDir, 'pastq-pages.db'), { readOnly: true });
const pages = src.prepare("SELECT * FROM pages WHERE session_id = ? AND status IN ('done','skipped') ORDER BY idx").all(sessionId);
const results = src.prepare('SELECT page_id, json FROM results WHERE session_id = ?').all(sessionId);
if (!pages.length) throw new Error('No finished pages to import');

// Fresh copy each time: replace any earlier preview of this session.
pageStore.deleteSessionPages(sessionId);
pageStore.addPages(sessionId, pages.map((p) => ({
  id: p.page_id, index: p.idx, status: p.status, source: p.source, filename: p.filename,
  imagePath: p.image_path, textPath: p.text_path, width: p.width, height: p.height,
})));
for (const p of pages) {
  pageStore.updatePage(p.page_id, { pageType: p.page_type, legibility: p.legibility, turns: p.turns, inspections: p.inspections, questions: p.questions });
}
const finished = new Set(pages.map((p) => p.page_id));
for (const r of results) if (finished.has(r.page_id)) pageStore.saveResult(sessionId, r.page_id, JSON.parse(r.json));

const srcFigures = path.join(sourceDir, 'pages', sessionId, 'figures');
const dstFigures = path.join(pageDir(sessionId), 'figures');
fs.mkdirSync(dstFigures, { recursive: true });
if (fs.existsSync(srcFigures)) for (const f of fs.readdirSync(srcFigures)) fs.copyFileSync(path.join(srcFigures, f), path.join(dstFigures, f));

const srcSession = JSON.parse(fs.readFileSync(path.join(sourceDir, 'sessions', `${sessionId}.json`), 'utf8'));
// Owned by the local development user so it also appears in their sessions.
const ownerSecret = process.env.SESSION_OWNER_HMAC_SECRET || 'pastq-local-owner-secret';
const ownerKey = crypto.createHmac('sha256', ownerSecret).update('local-development-user').digest('base64url');
const existing = getSession(sessionId);
if (withOutput) {
  const { syncSessionToLibrary } = await import('../services/library/librarySync.js');
  saveSession({ ...srcSession, ownerKey });
  const sync = await syncSessionToLibrary(getSession(sessionId));
  console.log(`imported ${pages.length} pages with assembled output; library: ${JSON.stringify(sync.synced ? { bundleId: sync.bundleId } : sync)}`);
  process.exit(0);
}
saveSession({
  ...srcSession,
  ownerKey,
  name: `${srcSession.name} (preview: ${pages.length} pages)`,
  status: 'processing',
  ingest: { status: 'done', pagesDone: pages.length },
  questions: [], groups: [], answerKeys: [], outline: null, questionIdByKey: {}, adjudications: {},
  libraryMeta: undefined,
  followUps: [],
  cost: existing?.cost || srcSession.cost,
});
console.log(`imported ${pages.length} pages, ${results.filter((r) => finished.has(r.page_id)).length} results, figures copied`);
