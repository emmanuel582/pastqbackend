import { Router } from 'express';
import { requireAuthenticatedUser } from '../services/auth/middleware.js';
import { rateLimit } from '../services/http/security.js';
import { validateSettings, validateActivity, planReminder } from '../services/reminders/planner.js';
import { pushConfiguration, validateSubscription, sendTestReminder } from '../services/reminders/delivery.js';
import * as store from '../services/reminders/store.js';
const router = Router();
router.use(requireAuthenticatedUser, rateLimit({ limit: 40, keyPrefix: 'reminders' }), (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
function snapshot(owner, ownerId) { const settings = store.readSettings(owner), config = pushConfiguration(), activity = store.readActivity(owner); return { ownerId, settings, activityCount: activity.length, push: { configured: Boolean(config), publicKey: config?.publicKey || null, devices: store.subscriptions(owner).map(item => item.id) }, preview: planReminder(settings, activity), lastDelivery: store.lastDelivery(owner) }; }
router.get('/', (req, res, next) => { try { res.json(snapshot(req.auth.ownerKey, req.auth.user.id)); } catch (error) { next(error); } });
router.put('/', (req, res, next) => {
  try { const owner = req.auth.ownerKey, settings = validateSettings(req.body, store.readSettings(owner)); if (settings.enabled && (!pushConfiguration() || !store.subscriptions(owner).length)) return res.status(409).json({ error: 'Connect a device before enabling reminders.' }); store.saveSettings(owner, settings); res.json(snapshot(owner, req.auth.user.id)); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});
router.put('/subscription', (req, res, next) => { try { if (!pushConfiguration()) return res.status(503).json({ error: 'Study notifications are not configured on the server yet.' }); store.saveSubscription(req.auth.ownerKey, validateSubscription(req.body)); res.json(snapshot(req.auth.ownerKey, req.auth.user.id)); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); } });
router.delete('/subscription', (req, res, next) => { try { if (typeof req.body?.endpoint !== 'string') return res.status(400).json({ error: 'Provide the current device subscription.' }); store.removeSubscription(req.auth.ownerKey, store.subscriptionId(req.body.endpoint)); res.json(snapshot(req.auth.ownerKey, req.auth.user.id)); } catch (error) { next(error); } });
router.post('/activity', (req, res, next) => { try { store.saveActivity(req.auth.ownerKey, validateActivity(req.body?.sessions)); res.status(202).json({ accepted: true }); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); } });
router.post('/test', rateLimit({ limit: 3, keyPrefix: 'reminder-test' }), async (req, res, next) => { try { await sendTestReminder(req.auth.ownerKey, req.body?.endpoint); res.json(snapshot(req.auth.ownerKey, req.auth.user.id)); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); } });
export default router;
