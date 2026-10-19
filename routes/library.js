import { Router } from 'express';
import {
  getCatalog,
  getBundle,
  getBundleDownload,
  listBundles,
  searchBundles,
  upsertSessionToLibrary,
  applyAnswersToBundle,
  reclassifyBundle,
} from '../services/library/store.js';
import { getLibraryActivity } from '../services/library/activity.js';
import { getSession, saveSession } from '../services/vision/store.js';
import { classifyLibrarySession } from '../services/vision/libraryClassifier.js';
import { TAXONOMY_VERSION } from '../services/vision/educationTaxonomy.js';
import { requireAdmin, requireAuthenticatedUser, ownsSession } from '../services/auth/middleware.js';
import { figurePath } from '../services/vision/figures.js';
import { partitionBundle, partDownload } from '../services/library/downloadParts.js';

const router = Router();

router.get('/catalog', (_req, res) => {
  try {
    res.json(getCatalog());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bundles', (req, res) => {
  try {
    const { query, university, organization, examType, manufacturer, stream, full } = req.query;
    if (full === '1' || full === 'true') {
      let bundles = listBundles();
      if (university) bundles = bundles.filter((b) => String(b.university || '').toLowerCase().includes(String(university).toLowerCase()));
      if (examType) bundles = bundles.filter((b) => String(b.examType || '').toLowerCase().includes(String(examType).toLowerCase()));
      if (manufacturer) bundles = bundles.filter((b) => String(b.manufacturer || '').toLowerCase().includes(String(manufacturer).toLowerCase()));
      if (query) {
        const q = String(query).toLowerCase();
        bundles = bundles.filter(
          (b) =>
            (b.title || '').toLowerCase().includes(q) ||
            (b.manufacturer || '').toLowerCase().includes(q) ||
            (b.questions || []).some((x) => (x.question || '').toLowerCase().includes(q))
        );
      }
      return res.json({ total: bundles.length, bundles, full: true });
    }
    const bundles = searchBundles({ query, university, organization, examType, manufacturer, stream });
    res.json({ total: bundles.length, bundles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/activity', requireAuthenticatedUser, requireAdmin, (req, res) => {
  try {
    const since = req.query.since || 'today';
    const limit = parseInt(req.query.limit || '100', 10);
    res.json(getLibraryActivity({ since, limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/bundles/:id/answers', requireAuthenticatedUser, requireAdmin, (req, res) => {
  try {
    const updates = req.body?.updates || req.body?.answers || [];
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ error: 'Provide updates[] with id or questionNumber and correct/correctLetter' });
    }
    const result = applyAnswersToBundle(req.params.id, updates);
    if (!result.ok) return res.status(404).json(result);

    // Mirror into source session JSON if present
    const bundle = getBundle(req.params.id);
    const sessionIds = bundle?.sourceSessionIds || [];
    for (const sid of sessionIds) {
      const session = getSession(sid);
      if (!session) continue;
      for (const u of updates) {
        let q = session.questions?.find((x) => u.id != null && String(x.id) === String(u.id));
        if (!q && u.questionNumber != null) {
          q = session.questions?.find((x) => Number(x.questionNumber) === Number(u.questionNumber));
        }
        if (!q) continue;
        if (u.correctLetter != null) {
          q.correct = 'ABCDE'.indexOf(String(u.correctLetter).toUpperCase());
          q.correctLetter = String(u.correctLetter).toUpperCase();
        } else if (u.correct != null) {
          q.correct = u.correct;
        }
        if (u.explanation != null) q.explanation = u.explanation;
        q.needsReview = false;
        q.answerSource = 'manual_apply';
      }
      saveSession(session);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/bundles/:id/classification', requireAuthenticatedUser, requireAdmin, (req, res) => {
  try {
    const result = reclassifyBundle(req.params.id, req.body || {});
    if (!result.ok) return res.status(result.error === 'Bundle not found' ? 404 : 400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update classification' });
  }
});

router.get('/bundles/:id/manifest', (req, res) => {
  try { const bundle=getBundle(req.params.id); if (!bundle || bundle.libraryVisibility === 'private') return res.status(404).json({error:'Bundle not found'}); res.set('Cache-Control','no-cache').json(partitionBundle(bundle)); }
  catch { res.status(400).json({error:'Could not prepare this download'}); }
});
router.get('/bundles/:id/parts/:hash', (req,res) => {
  const download=partDownload(req.params.id,req.params.hash,!!req.get('Accept-Encoding')&&!!req.acceptsEncodings('gzip')); if (!download) return res.status(404).json({error:'Download part unavailable. Refresh the download.'});
  res.vary('Accept-Encoding');if(download.encoding)res.set('Content-Encoding',download.encoding);
  res.set('Cache-Control','public, max-age=31536000, immutable').type('application/json').sendFile(download.file);
});
router.get('/bundles/:id', (req, res) => {
  try {
    const download = getBundleDownload(req.params.id, !!req.get('Accept-Encoding') && !!req.acceptsEncodings('gzip'));
    if (!download) return res.status(404).json({ error: 'Bundle not found' });
    res.vary('Accept-Encoding');
    if (download.encoding) res.set('Content-Encoding', download.encoding);
    res.type('application/json').sendFile(download.file);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Internal: merge a completed session into library (also called from librarySync) */
router.post('/bundles/:id/merge', requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || req.params.id;
    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!session.libraryMeta || session.libraryMeta.taxonomyVersion !== TAXONOMY_VERSION) {
      session.libraryMeta = await classifyLibrarySession(session, {
        uploaderName: req.body?.uploaderName,
        uploaderEmail: req.body?.uploaderEmail,
      });
      saveSession(session);
    }

    const { bundle } = upsertSessionToLibrary(session, session.libraryMeta);
    res.json({ ok: true, bundleId: bundle.id, questionCount: bundle.questions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Question figures (exact crops of the source page). Served without auth so
 * <img src> works; file names carry a random suffix and are validated strictly.
 */
router.get('/figures/:sessionId/:file', (req, res, next) => {
  let session;
  try { session = getSession(req.params.sessionId); } catch { return res.status(404).json({error:'Figure not found'}); }
  if (session?.libraryVisibility !== 'private') return next();
  requireAuthenticatedUser(req,res,() => {
    if (!ownsSession(req,session)) return res.status(404).json({error:'Figure not found'});
    res.set('Cache-Control','private, no-store'); next();
  });
}, (req, res) => {
  const full = figurePath(req.params.sessionId, req.params.file);
  if (!full) return res.status(404).json({ error: 'Figure not found' });
  if (!res.get('Cache-Control')) res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/jpeg').sendFile(full);
});

/** Flat list fallback for legacy clients */
router.get('/', (_req, res) => {
  try {
    const bundles = listBundles({ summaries: true }).map((b) => ({
      id: b.id,
      title: b.title || b.name,
      name: b.name,
      icon: b.icon || '📚',
      university: b.university,
      examType: b.examType,
      manufacturer: b.manufacturer,
      question_count: b.question_count ?? (b.questions || []).length,
      status: b.status || 'published',
      updated_at: b.updated_at,
    }));
    res.json({ materials: bundles, bundles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
