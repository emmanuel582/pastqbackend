import { Router } from 'express';
import { requireAuthenticatedUser } from '../services/auth/middleware.js';
import { rateLimit } from '../services/http/security.js';
import { getQuestionStats, recordAttemptSummary } from '../services/recommendations/aggregateStore.js';

const router = Router();
router.use(requireAuthenticatedUser);
router.use(rateLimit({ limit: 60, keyPrefix: 'recommendations' }));

function validKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300;
}

router.post('/attempts', (req, res) => {
  const incoming = Array.isArray(req.body?.attempts) ? req.body.attempts : [];
  if (!incoming.length || incoming.length > 500) {
    return res.status(400).json({ error: 'Provide between 1 and 500 attempt summaries.' });
  }
  const attempts = [];
  for (const item of incoming) {
    if (!validKey(item?.questionKey) || ![true, false, null].includes(item.isCorrect ?? null)) {
      return res.status(400).json({ error: 'Invalid anonymous attempt summary.' });
    }
    attempts.push({ questionKey: item.questionKey, isCorrect: item.isCorrect ?? null });
  }
  recordAttemptSummary(attempts);
  return res.status(202).json({ accepted: attempts.length });
});

router.get('/question-stats', (req, res) => {
  const keys = String(req.query.keys || '')
    .split(',')
    .filter(validKey)
    .slice(0, 200);
  if (!keys.length) return res.status(400).json({ error: 'Provide at least one question key.' });
  return res.json({ stats: getQuestionStats(keys) });
});

export default router;
