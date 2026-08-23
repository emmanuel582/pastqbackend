import { Router } from 'express';
import {
  getCatalog,
  getBundle,
  listBundles,
  searchBundles,
  upsertSessionToLibrary,
} from '../services/library/store.js';
import { getSession } from '../services/vision/store.js';
import { classifyLibrarySession } from '../services/vision/libraryClassifier.js';
import { saveSession } from '../services/vision/store.js';

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
    const { query, university, examType, manufacturer } = req.query;
    const bundles = searchBundles({ query, university, examType, manufacturer });
    res.json({ total: bundles.length, bundles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bundles/:id', (req, res) => {
  try {
    const bundle = getBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Internal: merge a completed session into library (also called from librarySync) */
router.post('/bundles/:id/merge', async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || req.params.id;
    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!session.libraryMeta) {
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

/** Flat list fallback for legacy clients */
router.get('/', (_req, res) => {
  try {
    const bundles = listBundles().map((b) => ({
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
