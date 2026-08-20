import express from 'express';
const router = express.Router();
import multer from 'multer';
import crypto from 'crypto';

import { 
  getJobs,
  saveJobs,
  createSession,
  getSession,
  saveSession,
  listSessions,
  deleteSession,
  updateProgress,
  publicSession,
 } from '../services/vision/store.js';
import {  savePageImage, isPdf  } from '../services/vision/image.js';
import {  savePdfFile  } from '../services/vision/pdf.js';
import { 
  kickoffSession,
  runOcrPdf,
  addCost,
  mergeFollowUps,
  rebuildGroups,
  applyAnswerKeys,
  MAX_RETRIES,
 } from '../services/vision/processor.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 200 },
});

if (!process.env.MISTRAL_API_KEY) {
  console.warn('Warning: MISTRAL_API_KEY is not set in .env');
}

function addPagesFromImages(session, files) {
  const startIndex = session.pages.length;
  const added = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pageId = crypto.randomUUID();
    const index = startIndex + i;
    added.push({ file, pageId, index });
  }
  return added;
}

async function materializeImagePages(session, items) {
  for (const item of items) {
    const saved = await savePageImage(session.id, item.index, item.file.buffer);
    session.pages.push({
      id: item.pageId,
      index: item.index,
      status: 'pending',
      retryCount: 0,
      filename: item.file.originalname || saved.filename,
      imagePath: saved.fullPath,
      // keep dataUrl briefly for first OCR; worker clears it
      dataUrl: saved.dataUrl,
      pageType: null,
      error: null,
    });
  }
  updateProgress(session);
  saveSession(session);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

router.post('/sessions', (req, res) => {
  try {
    const { name, icon, subjectHint } = req.body || {};
    const id = crypto.randomUUID();
    const session = createSession({ id, name, icon, subjectHint });
    console.log(`[vision] session created ${id} name="${session.name}"`);
    res.json(publicSession(session));
  } catch (err) {
    console.error('[vision] create session failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create session' });
  }
});

router.get('/sessions', (_req, res) => {
  res.json(listSessions().map(publicSession));
});

router.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(publicSession(session));
});

router.delete('/sessions/:id', (req, res) => {
  deleteSession(req.params.id);
  const jobs = getJobs();
  if (jobs[req.params.id]) {
    delete jobs[req.params.id];
    saveJobs(jobs);
  }
  res.json({ success: true });
});

router.delete('/sessions', (_req, res) => {
  const sessions = listSessions();
  for (const s of sessions) {
    deleteSession(s.id);
  }
  saveJobs({});
  res.json({ success: true, count: sessions.length });
});

router.post('/sessions/:id/pages', upload.array('images', 200), async (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No images uploaded' });

    const imageFiles = files.filter((f) => !isPdf(f));
    if (!imageFiles.length) {
      return res.status(400).json({ error: 'No image files found. Use /pdf endpoint for PDFs.' });
    }

    const items = addPagesFromImages(session, imageFiles);
    await materializeImagePages(session, items);

    // Don't start processing yet — wait for client to call /start after all chunks uploaded
    session.status = 'uploading';
    saveSession(session);
    console.log(`[vision] ${imageFiles.length} image(s) queued for ${session.id} (total: ${session.pages.length})`);

    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error('[vision] add pages failed:', err);
    res.status(500).json({ error: err.message || 'Failed to add pages' });
  }
});

// ── Start processing (called after all pages are uploaded) ───────────────────
router.post('/sessions/:id/start', (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.pages.length) return res.status(400).json({ error: 'No pages to process' });

    session.status = 'processing';
    saveSession(session);
    console.log(`[vision] starting processing for ${session.id} — ${session.pages.length} pages`);
    kickoffSession(session.id);

    res.json(publicSession(session));
  } catch (err) {
    console.error('[vision] start session failed:', err);
    res.status(500).json({ error: err.message || 'Failed to start session' });
  }
});

router.post('/sessions/:id/pdf', upload.single('pdf'), async (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    res.json({ id: session.id, status: 'processing', message: 'PDF accepted; OCR starting' });

    (async () => {
      try {
        const saved = await savePdfFile(session.id, req.file.buffer, req.file.originalname);
        const fresh = getSession(session.id);
        fresh.status = 'processing';
        saveSession(fresh);

        const ocrResponse = await runOcrPdf(saved.dataUrl);
        const ocrPages = ocrResponse.pages || [];
        const pagesProcessed =
          ocrResponse.usageInfo?.pagesProcessed ??
          ocrResponse.usage_info?.pages_processed ??
          (ocrPages.length || 1);

        const s = getSession(session.id);
        addCost(s, { ocrPages: pagesProcessed });

        const startIndex = s.pages.length;
        for (let i = 0; i < ocrPages.length; i++) {
          const md = (ocrPages[i].markdown || '').trim();
          s.pages.push({
            id: crypto.randomUUID(),
            index: startIndex + i,
            status: 'pending',
            retryCount: 0,
            filename: `pdf-page-${startIndex + i + 1}`,
            ocrMarkdown: md,
            pageType: null,
            error: null,
            source: 'pdf',
          });
        }
        updateProgress(s);
        saveSession(s);
        kickoffSession(s.id);
      } catch (err) {
        console.error('PDF session error:', err);
        const s = getSession(session.id);
        if (s) {
          s.status = 'failed';
          s.error = err.message || String(err);
          mergeFollowUps(s, [
            {
              id: `pdf-fail-${session.id}`,
              type: 'pdf_failed',
              message: `PDF processing failed: ${s.error}. Please retry or upload page photos instead.`,
            },
          ]);
          saveSession(s);
        }
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept PDF' });
  }
});

router.post('/sessions/:id/resume', (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let requeued = 0;
    for (const page of session.pages) {
      if (page.status === 'failed' || page.status === 'needs_input') {
        page.status = 'pending';
        page.error = null;
        page.retryCount = Math.min(page.retryCount || 0, MAX_RETRIES - 1);
        requeued += 1;
      }
    }
    session.status = 'processing';
    updateProgress(session);
    saveSession(session);
    kickoffSession(session.id);
    res.json({ ...publicSession(session), requeued });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resume session' });
  }
});

router.post('/sessions/:id/reply', upload.single('image'), async (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { followUpId, message, action, year, paper } = req.body || {};
    const fu = (session.followUps || []).find((f) => f.id === followUpId);

    if (fu) {
      fu.status = 'resolved';
      fu.resolution = message || action || 'acknowledged';
      fu.resolvedAt = Date.now();
    }

    if (year) session.memory.activeYear = String(year);
    if (paper) session.memory.activePaper = String(paper);

    // Replace unclear page image if provided
    if (req.file && fu?.pageId) {
      const page = session.pages.find((p) => p.id === fu.pageId);
      if (page) {
        const saved = await savePageImage(session.id, page.index, req.file.buffer);
        page.imagePath = saved.fullPath;
        page.dataUrl = saved.dataUrl;
        page.ocrMarkdown = null;
        page.status = 'pending';
        page.error = null;
        page.retryCount = 0;
      }
    } else if (req.file) {
      // Attach as a new page (e.g. missing page)
      const index = session.pages.length;
      const saved = await savePageImage(session.id, index, req.file.buffer);
      session.pages.push({
        id: crypto.randomUUID(),
        index,
        status: 'pending',
        retryCount: 0,
        filename: req.file.originalname || saved.filename,
        imagePath: saved.fullPath,
        dataUrl: saved.dataUrl,
        pageType: null,
        error: null,
      });
    }

    // Apply manual year/paper override to unmatched questions if requested
    if (action === 'set_group' && (year || paper)) {
      for (const q of session.questions) {
        if (year && (!q.year || q.year === 'Unknown')) q.year = String(year);
        if (paper && (!q.paper || q.paper === 'Default')) q.paper = String(paper);
      }
      rebuildGroups(session);
    }

    if (action === 'dismiss' && fu) {
      fu.status = 'resolved';
    }

    applyAnswerKeys(session);
    updateProgress(session);
    session.status = 'processing';
    saveSession(session);
    kickoffSession(session.id);

    res.json(publicSession(getSession(session.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to handle reply' });
  }
});

// ── Legacy single-image extract (wraps session) ───────────────────────────────

router.post('/extract', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const { name, icon, subjectHint } = req.body || {};
    const id = crypto.randomUUID();
    const session = createSession({ id, name, icon, subjectHint });

    if (isPdf(req.file)) {
      res.json({ jobId: id, sessionId: id, status: 'processing' });
      const saved = await savePdfFile(session.id, req.file.buffer, req.file.originalname);
      (async () => {
        try {
          const ocrResponse = await runOcrPdf(saved.dataUrl);
          const ocrPages = ocrResponse.pages || [];
          const pagesProcessed =
            ocrResponse.usageInfo?.pagesProcessed ??
            ocrResponse.usage_info?.pages_processed ??
            (ocrPages.length || 1);
          const s = getSession(id);
          addCost(s, { ocrPages: pagesProcessed });
          for (let i = 0; i < ocrPages.length; i++) {
            s.pages.push({
              id: crypto.randomUUID(),
              index: i,
              status: 'pending',
              retryCount: 0,
              filename: `pdf-page-${i + 1}`,
              ocrMarkdown: (ocrPages[i].markdown || '').trim(),
              pageType: null,
              error: null,
              source: 'pdf',
            });
          }
          s.status = 'processing';
          updateProgress(s);
          saveSession(s);
          kickoffSession(s.id);
        } catch (err) {
          const s = getSession(id);
          if (s) {
            s.status = 'failed';
            s.error = err.message || String(err);
            saveSession(s);
          }
        }
      })();
      return;
    }

    const saved = await savePageImage(session.id, 0, req.file.buffer);
    session.pages.push({
      id: crypto.randomUUID(),
      index: 0,
      status: 'pending',
      retryCount: 0,
      filename: req.file.originalname || saved.filename,
      imagePath: saved.fullPath,
      dataUrl: saved.dataUrl,
      pageType: null,
      error: null,
    });
    session.status = 'processing';
    updateProgress(session);
    saveSession(session);

    // Mirror legacy job
    const jobs = getJobs();
    jobs[id] = { id, status: 'processing', name: session.name, icon: session.icon, createdAt: Date.now(), session: true };
    saveJobs(jobs);

    res.json({ jobId: id, sessionId: id, status: 'processing' });
    kickoffSession(id);
  } catch (error) {
    console.error('Vision API Error:', error);
    res.status(500).json({ error: 'Failed to initiate processing' });
  }
});

router.post('/extract-text', async (req, res) => {
  try {
    const { text, name, icon } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const id = crypto.randomUUID();
    const session = createSession({ id, name: name || 'Manual Entry', icon: icon || '📝' });
    session.pages.push({
      id: crypto.randomUUID(),
      index: 0,
      status: 'pending',
      retryCount: 0,
      filename: 'manual-text',
      ocrMarkdown: String(text),
      pageType: null,
      error: null,
      source: 'text',
    });
    session.status = 'processing';
    updateProgress(session);
    saveSession(session);

    const jobs = getJobs();
    jobs[id] = { id, status: 'processing', name: session.name, icon: session.icon, createdAt: Date.now(), session: true };
    saveJobs(jobs);

    res.json({ jobId: id, sessionId: id, status: 'processing' });
    kickoffSession(id);
  } catch (error) {
    console.error('Text API Error:', error);
    res.status(500).json({ error: 'Failed to initiate processing' });
  }
});

router.get('/jobs/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (session) return res.json(publicSession(session));
  const jobs = getJobs();
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.get('/jobs', (_req, res) => {
  const sessions = listSessions().map(publicSession);
  const jobs = getJobs();
  const legacy = Object.values(jobs).filter((j) => !sessions.some((s) => s.id === j.id));
  res.json([...sessions, ...legacy]);
});

router.delete('/jobs/:id', (req, res) => {
  deleteSession(req.params.id);
  const jobs = getJobs();
  if (jobs[req.params.id]) {
    delete jobs[req.params.id];
    saveJobs(jobs);
  }
  res.json({ success: true });
});

export default router;
