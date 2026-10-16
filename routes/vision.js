import express from 'express';
import multer from 'multer';
import crypto from 'crypto';

import {
  getJobs,
  saveJobs,
  createSession,
  getSession,
  listSessions,
  deleteSession,
  publicSession,
} from '../services/vision/store.js';
import * as pageStore from '../services/vision/pageStore.js';
import { appendSessionEvent } from '../services/vision/events.js';
import { collectDroppedItems, getSessionEvents, getOpsLogs, getPageOcr } from '../services/vision/audit.js';
import { savePageImage, isPdf } from '../services/vision/image.js';
import { savePdfFile, validatePdfBuffer } from '../services/vision/pdf.js';
import {
  kickoffSession,
  ingestPdfIntoSession,
  withSessionLock,
  addTextPages,
  abortSession,
} from '../services/vision/processor.js';
import { schedulerStats } from '../services/vision/scheduler.js';
import { requireAdmin, requireAuthenticatedUser, ownsSession } from '../services/auth/middleware.js';
import { rateLimit, uploadRateLimit } from '../services/http/security.js';
import { reviewedMaterial, reviewQuestions } from '../services/vision/reviewedMaterials.js';
import { saveReviewedMaterial, listReviewedMaterials, getReviewedMaterial, deleteReviewedMaterial } from '../services/vision/reviewedMaterialStore.js';

const router = express.Router();
const maxUploadFiles = Number(process.env.MAX_UPLOAD_FILES || 80);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_MB || 200) * 1024 * 1024,
    files: maxUploadFiles,
  },
});

if (!process.env.OPENROUTER_API_KEY) {
  console.warn('Warning: OPENROUTER_API_KEY is not set in .env');
}

function getOwnedSession(req, res) {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return null;
  }
  if (!ownsSession(req, session)) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this session' } });
    return null;
  }
  return session;
}

function removeJob(id) {
  const jobs = getJobs();
  if (jobs[id]) {
    delete jobs[id];
    saveJobs(jobs);
  }
}

function imagePage(saved, index, filename) {
  return {
    id: crypto.randomUUID(), index, status: 'pending', filename: filename || saved.filename, imagePath: saved.fullPath,
    width: saved.original?.width || null, height: saved.original?.height || null, source: 'image',
  };
}

/**
 * Inserting pages mid-document changes every later page number, so the whole
 * document is transcribed again (results and decisions are dropped).
 */
async function resetExtraction(sessionId) {
  pageStore.requeue(sessionId, ['done', 'skipped', 'failed', 'processing']);
  pageStore.clearSessionResults(sessionId);
  await withSessionLock(sessionId, (s) => {
    Object.assign(s, { outline: null, questions: [], groups: [], answerKeys: [], questionIdByKey: {}, adjudications: {} });
  });
}

function parseInsertAt(body) {
  if (body?.insertAt == null || body.insertAt === '') return null;
  const n = Number(body.insertAt);
  if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error('insertAt must be a page index (0 or more)'), { status: 400 });
  return n;
}

// All extraction artefacts live on the VPS, but every artefact is bound to a
// one-way key derived from a verified Supabase user. There is no anonymous
// upload, user profile copied to Hostinger, or cross-student read.
router.use(requireAuthenticatedUser);
router.use(rateLimit());

// ── Sessions ──────────────────────────────────────────────────────────────────

router.post('/sessions', (req, res) => {
  const { name, icon, subjectHint } = req.body || {};
  const session = createSession({ id: crypto.randomUUID(), name, icon, subjectHint, ownerKey: req.auth.ownerKey });
  res.json(publicSession(session));
});

router.get('/sessions', (req, res) => {
  res.json(listSessions().filter((session) => ownsSession(req, session)).map(publicSession));
});

router.get('/sessions/:id', (req, res) => {
  const session = getOwnedSession(req, res);
  if (session) res.json(publicSession(session));
});

router.get('/materials', (req, res) => {
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  res.set('Cache-Control', 'no-store');
  res.json(listReviewedMaterials(req.auth.ownerKey, offset, limit));
});

router.get('/materials/:id', (req, res) => {
  const material = getReviewedMaterial(req.auth.ownerKey, req.params.id);
  if (!material) return res.status(404).json({ error: 'Saved material not found.' });
  res.set('Cache-Control', 'no-store');
  res.json(material);
});

router.put('/sessions/:id/confirm', async (req, res) => {
  if (!getOwnedSession(req, res)) return;
  try {
    let material;
    await withSessionLock(req.params.id, session => {
      session.questions = reviewQuestions(session, req.body?.questions);
      session.approvedAt = session.approvedAt || new Date().toISOString();
      session.updatedAt = Date.now();
      material = reviewedMaterial(session);
      saveReviewedMaterial(req.auth.ownerKey, material);
    });
    if (!material) return res.status(404).json({ error: 'Material no longer exists.' });
    res.set('Cache-Control', 'no-store');
    res.json(material);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save this material. Please try again.' });
  }
});

function deleteOwned(req, res) {
  const session = getOwnedSession(req, res);
  if (!session) return;
  abortSession(session.id);
  deleteReviewedMaterial(session.id);
  deleteSession(session.id);
  removeJob(session.id);
  res.json({ success: true });
}
router.delete('/sessions/:id', deleteOwned);
router.post('/sessions/:id/cancel', deleteOwned);

router.delete('/sessions', (req, res) => {
  const sessions = listSessions().filter((session) => ownsSession(req, session));
  for (const s of sessions) {
    abortSession(s.id);
    deleteReviewedMaterial(s.id);
    deleteSession(s.id);
    removeJob(s.id);
  }
  res.json({ success: true, count: sessions.length });
});

/**
 * Add page images. Optional `insertAt` (0-based) places them before that
 * page; otherwise they are appended in upload order.
 */
router.post('/sessions/:id/pages', uploadRateLimit, upload.array('images', maxUploadFiles), async (req, res) => {
  try {
    if (!getOwnedSession(req, res)) return;
    const files = (req.files || []).filter((f) => !isPdf(f));
    if (!files.length) return res.status(400).json({ error: 'No image files uploaded. Use /pdf for PDFs.' });
    const insertAt = parseInsertAt(req.body);
    const end = pageStore.nextIndex(req.params.id);
    const position = insertAt != null && insertAt < end ? insertAt : end;
    if (position < end) pageStore.shiftIndices(req.params.id, position, files.length);
    const pages = [];
    for (const [i, file] of files.entries()) {
      try {
        const saved = await savePageImage(req.params.id, `${position + i}-${crypto.randomUUID().slice(0, 8)}`, file.buffer);
        pages.push(imagePage(saved, position + i, file.originalname));
      } catch (err) {
        if (position < end) pageStore.shiftIndices(req.params.id, position + files.length, -files.length);
        return res.status(400).json({ error: `${file.originalname || `File ${i + 1}`}: ${err.message}` });
      }
    }
    pageStore.addPages(req.params.id, pages);
    if (position < end) await resetExtraction(req.params.id);
    const session = await withSessionLock(req.params.id, (s) => {
      if (s.status === 'pending') s.status = 'uploading';
      return s;
    });
    res.json(publicSession(session));
  } catch (err) {
    console.error('[vision] add pages failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to add pages' });
  }
});

router.post('/sessions/:id/start', async (req, res) => {
  if (!getOwnedSession(req, res)) return;
  if (!pageStore.statusCounts(req.params.id).total) return res.status(400).json({ error: 'No pages to process' });
  const session = await withSessionLock(req.params.id, (s) => { s.status = 'processing'; return s; });
  kickoffSession(session.id);
  res.json(publicSession(session));
});

router.post('/sessions/:id/pdf', uploadRateLimit, upload.single('pdf'), async (req, res) => {
  const session = getOwnedSession(req, res);
  if (!session) return;
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  try {
    validatePdfBuffer(req.file.buffer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const saved = await savePdfFile(session.id, req.file.buffer, req.file.originalname);
  res.json({ id: session.id, status: 'processing', message: 'PDF accepted; pages are being prepared' });
  ingestPdfIntoSession(session.id, saved.fullPath).catch((err) => console.error(`[vision] PDF ingest failed for ${session.id}:`, err.message));
});

/** Retry everything that failed, paused or needs attention. */
router.post('/sessions/:id/resume', async (req, res) => {
  if (!getOwnedSession(req, res)) return;
  const requeued = pageStore.requeue(req.params.id, ['failed', 'processing']);
  const session = await withSessionLock(req.params.id, (s) => {
    s.followUps = (s.followUps || []).filter((f) => !['paused', 'page_failed', 'structure_failed', 'worker_error', 'conflicts_unresolved', 'library_sync_failed'].includes(f.type) || f.status === 'resolved');
    s.status = 'processing';
    return s;
  });
  kickoffSession(session.id);
  res.json({ ...publicSession(session), requeued });
});

/**
 * Answer a follow-up: replace a page image (re-transcribes that page), add a
 * missing page at a position, set default year/paper labels, or dismiss.
 */
router.post('/sessions/:id/reply', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const owned = getOwnedSession(req, res);
    if (!owned) return;
    const { followUpId, message, action, year, paper } = req.body || {};
    const insertAt = parseInsertAt(req.body);
    const fu = (owned.followUps || []).find((f) => f.id === followUpId);
    const target = fu?.pageId ? pageStore.getPage(fu.pageId) : null;

    if (req.file && target) {
      const saved = await savePageImage(req.params.id, `${target.index}-${crypto.randomUUID().slice(0, 8)}`, req.file.buffer);
      pageStore.deleteResult(target.id);
      pageStore.updatePage(target.id, { imagePath: saved.fullPath, textPath: null, status: 'pending', attempts: 0, error: null, pageType: null });
    } else if (req.file) {
      const end = pageStore.nextIndex(req.params.id);
      const position = insertAt != null && insertAt < end ? insertAt : end;
      const saved = await savePageImage(req.params.id, `${position}-${crypto.randomUUID().slice(0, 8)}`, req.file.buffer);
      if (position < end) pageStore.shiftIndices(req.params.id, position, 1);
      pageStore.addPages(req.params.id, [imagePage(saved, position, req.file.originalname)]);
      if (position < end) await resetExtraction(req.params.id);
    }

    const session = await withSessionLock(req.params.id, (s) => {
      const f = (s.followUps || []).find((x) => x.id === followUpId);
      if (f) Object.assign(f, { status: 'resolved', resolution: message || action || 'acknowledged', resolvedAt: Date.now() });
      // Any changed page can change cross-page decisions.
      if (req.file) s.adjudications = {};
      if (action === 'set_group' && (year || paper)) s.manualDefaults = { year: year ? String(year) : null, paper: paper ? String(paper) : null };
      if (action === 'dismiss' && target?.status === 'failed') pageStore.updatePage(target.id, { status: 'skipped', error: 'dismissed by user' });
      if (pageStore.statusCounts(s.id).pending) s.status = 'processing';
      return s;
    });
    kickoffSession(session.id);
    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error('[vision] reply failed:', err);
    res.status(err.status || 400).json({ error: err.message || 'Failed to handle reply' });
  }
});

// ── One-shot extract (image or PDF) ───────────────────────────────────────────

router.post('/extract', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { name, icon, subjectHint } = req.body || {};
    const id = crypto.randomUUID();

    if (isPdf(req.file)) {
      try {
        validatePdfBuffer(req.file.buffer);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      createSession({ id, name, icon, subjectHint, ownerKey: req.auth.ownerKey });
      const saved = await savePdfFile(id, req.file.buffer, req.file.originalname);
      res.json({ jobId: id, sessionId: id, status: 'processing' });
      ingestPdfIntoSession(id, saved.fullPath).catch((err) => console.error(`[vision] PDF ingest failed for ${id}:`, err.message));
      return;
    }

    createSession({ id, name, icon, subjectHint, ownerKey: req.auth.ownerKey });
    let saved;
    try {
      saved = await savePageImage(id, 0, req.file.buffer);
    } catch (err) {
      deleteSession(id);
      return res.status(400).json({ error: err.message });
    }
    pageStore.addPages(id, [imagePage(saved, 0, req.file.originalname)]);
    await withSessionLock(id, (s) => { s.status = 'processing'; });
    res.json({ jobId: id, sessionId: id, status: 'processing' });
    kickoffSession(id);
  } catch (error) {
    console.error('[vision] extract failed:', error);
    res.status(500).json({ error: 'Failed to initiate processing' });
  }
});

/** Pasted text (any format, including JSON) is transcribed by the same pipeline. */
router.post('/extract-text', async (req, res) => {
  const { text, name, icon } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'No text provided' });
  const id = crypto.randomUUID();
  createSession({ id, name: name || 'Pasted questions', icon: icon || '📝', ownerKey: req.auth.ownerKey });
  const pageCount = addTextPages(id, String(text));
  await withSessionLock(id, (s) => {
    s.status = 'processing';
    appendSessionEvent(s, { type: 'text_pasted', chars: String(text).length, pages: pageCount });
  });
  res.json({ jobId: id, sessionId: id, status: 'processing', pageCount });
  kickoffSession(id);
});

// ── Audit ─────────────────────────────────────────────────────────────────────

router.get('/dropped', requireAdmin, (req, res) => {
  res.json(collectDroppedItems({ limit: parseInt(req.query.limit || '100', 10), sessionId: req.query.sessionId || undefined }));
});

router.get('/ops-logs', requireAdmin, (req, res) => {
  res.json(getOpsLogs({ limit: parseInt(req.query.limit || '200', 10), sessionId: req.query.sessionId || undefined }));
});

/** Live throughput of the shared model-call scheduler. */
router.get('/scheduler', requireAdmin, (_req, res) => {
  res.json(schedulerStats());
});

router.get('/sessions/:id/events', (req, res) => {
  if (!getOwnedSession(req, res)) return;
  res.json(getSessionEvents(req.params.id));
});

/** The validated transcription stored for one page. */
router.get('/sessions/:id/pages/:pageIndex/ocr', (req, res) => {
  if (!getOwnedSession(req, res)) return;
  const data = getPageOcr(req.params.id, parseInt(req.params.pageIndex, 10));
  if (data.error) return res.status(404).json(data);
  res.json(data);
});

router.get('/jobs/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Job not found' });
  if (!ownsSession(req, session)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this job' } });
  res.json(publicSession(session));
});

router.get('/jobs', (req, res) => {
  res.json(listSessions().filter((session) => ownsSession(req, session)).map(publicSession));
});

router.delete('/jobs/:id', deleteOwned);

export default router;
