import { Router } from 'express';
import { requireAuthenticatedUser, requireAdmin } from '../services/auth/middleware.js';
import { rateLimit } from '../services/http/security.js';
import { publicSessions, joinedSessions, joinPublicSession, joinPrivateSession, publishSession, endSession } from '../services/discover/store.js';
const router = Router();
router.use(requireAuthenticatedUser, rateLimit({ limit: 60, keyPrefix: 'discover' }), (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = action => (req, res, next) => { try { action(req, res); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); } };
router.get('/', handle((req, res) => res.json({ sessions: publicSessions(req.auth.ownerKey, typeof req.query.search === 'string' ? req.query.search : ''), joined: joinedSessions(req.auth.ownerKey) })));
router.post('/join', rateLimit({ limit: 8, keyPrefix: 'discover-code' }), handle((req, res) => res.json({ session: joinPrivateSession(req.auth.ownerKey, req.body?.code) })));
router.post('/:id/join', handle((req, res) => res.json({ session: joinPublicSession(req.auth.ownerKey, req.params.id) })));
// The teacher app is a later release. Publishing is restricted to trusted admins;
// ordinary students cannot list a private session or publish a fake tutorial.
router.post('/', requireAdmin, handle((req, res) => res.status(201).json(publishSession(req.auth.ownerKey, req.body))));
router.post('/:id/end', requireAdmin, handle((req, res) => { endSession(req.auth.ownerKey, req.params.id); res.json({ ended: true }); }));
export default router;
