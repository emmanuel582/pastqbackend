import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import webpush from 'web-push';
import { defaultSettings, validateSettings, validateActivity, planReminder, localClock, studyTime } from '../services/reminders/planner.js';
const now = new Date('2026-10-16T18:05:00Z');
const settings = () => ({ ...defaultSettings(), enabled: true, mode: 'scheduled' });
const activity = (id, at, subject = 'Physics', score = 4) => ({ id, at, subject, score, total: 10, durationSeconds: 1200 });
function subscription(suffix = 'one') { const curve = crypto.createECDH('prime256v1'); curve.generateKeys(); return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }; }
test('study reminders follow local days, quiet hours, pauses, and completed study instead of timers in a tab', () => {
  assert.equal(planReminder(settings(), [], now).due, true);
  assert.equal(planReminder(settings(), [], new Date('2026-10-16T20:05:00Z')).due, false);
  assert.equal(planReminder(settings(), [], new Date('2026-10-16T17:00:00Z')).due, false);
  assert.equal(planReminder(settings(), [], new Date('2026-10-16T19:40:00Z')).due, false);
  assert.equal(planReminder({ ...settings(), days: [1] }, [], now).due, false);
  assert.equal(planReminder({ ...settings(), pausedUntil: '2026-10-17T00:00:00Z' }, [], now).due, false);
  assert.equal(planReminder(settings(), [activity('today', '2026-10-16T09:00:00Z')], now).due, false);
  assert.deepEqual(localClock(new Date('2026-11-01T05:30:00Z'), 'America/New_York'), localClock(new Date('2026-11-01T06:30:00Z'), 'America/New_York'));
});
test('smart timing learns recent session starts, and private reminders omit study details', () => {
  const history = [activity('a', '2026-10-15T17:20:00Z'), activity('b', '2026-10-14T17:20:00Z', 'Maths', 8), activity('c', '2026-10-13T17:20:00Z')];
  const smart = { ...settings(), mode: 'smart' };
  assert.equal(studyTime(smart, history), 18 * 60);
  const preview = planReminder(smart, history, now);
  assert.equal(preview.streak, 3); assert.equal(preview.subject, 'Physics'); assert.match(preview.body, /Physics/);
  const privatePreview = planReminder({ ...smart, personalized: false }, history, now);
  assert.equal(privatePreview.subject, ''); assert.doesNotMatch(privatePreview.title + privatePreview.body, /Physics|Maths|3-day|40%/);
});
test('invalid times, time zones, day lists and untrusted activity are rejected', () => {
  for (const value of [{ time: '25:00' }, { timezone: 'Not/A_Zone' }, { days: [] }, { days: [7] }, { enabled: 'yes' }, { mode: 'scheduled', time: '23:00' }, { quietEnd: '21:00' }]) assert.throws(() => validateSettings(value));
  assert.throws(() => validateActivity([activity('../other-student', now.toISOString())], now.getTime()));
  assert.throws(() => validateActivity([{ ...activity('a', now.toISOString()), score: 11 }], now.getTime()));
  assert.throws(() => validateActivity([activity('a', 'bad-date')], now.getTime()));
  assert.equal(validateActivity([activity('safe-id', now.toISOString())], now.getTime())[0].subject, 'Physics');
});
async function isolatedStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-reminders-')); process.env.DATA_DIR = root;
  const store = await import('../services/reminders/store.js'); store.closeReminderStore();
  t.after(() => { store.closeReminderStore(); fs.rmSync(root, { recursive: true, force: true }); }); return store;
}
test('delivery is private, restart-safe, idempotent per day and cleans up expired devices', async t => {
  const store = await isolatedStore(t); const { dispatchDueReminders } = await import('../services/reminders/delivery.js');
  store.saveSettings('student-a', settings()); store.saveSettings('student-b', { ...settings(), enabled: false });
  store.saveSubscription('student-a', subscription('live')); store.saveSubscription('student-a', subscription('expired')); store.saveSubscription('student-b', subscription('other'));
  store.saveActivity('student-a', [activity('yesterday', '2026-10-15T18:00:00Z')]);
  let sends = 0;
  const send = async (device, payload) => { sends++; assert.match(payload.url, /reminder=study/); assert.doesNotMatch(device.endpoint, /other/); if (device.endpoint.endsWith('expired')) throw Object.assign(new Error('Expired'), { statusCode: 410 }); };
  assert.deepEqual(await dispatchDueReminders({ now, send }), { sent: 1, failed: 0 }); assert.equal(sends, 2);
  store.closeReminderStore();
  assert.equal(store.readActivity('student-b').length, 0); assert.equal(store.readActivity('student-a').length, 1); assert.equal(store.subscriptions('student-a').length, 1);
  assert.deepEqual(await dispatchDueReminders({ now: new Date(now.getTime() + 120000), send }), { sent: 0, failed: 0 }); assert.equal(sends, 2);
  assert.equal(store.claimDelivery('student-a', '2026-10-16', now.getTime() + 3600000), false);
});
test('network failures back off, device ownership transfers explicitly, and disabled reminders stop', async t => {
  const store = await isolatedStore(t); const { dispatchDueReminders } = await import('../services/reminders/delivery.js');
  const shared = subscription('shared'); store.saveSubscription('old-account', shared); store.saveSubscription('new-account', shared);
  assert.equal(store.subscriptions('old-account').length, 0); assert.equal(store.subscriptions('new-account').length, 1);
  store.saveSettings('new-account', settings()); let sends = 0;
  const send = async () => { sends++; throw new Error('Temporary network failure'); };
  await dispatchDueReminders({ now, send }); await dispatchDueReminders({ now: new Date(now.getTime() + 120000), send }); assert.equal(sends, 1);
  await dispatchDueReminders({ now: new Date(now.getTime() + 16 * 60000), send }); assert.equal(sends, 2);
  store.saveSettings('new-account', { ...settings(), enabled: false }); await dispatchDueReminders({ now: new Date(now.getTime() + 32 * 60000), send }); assert.equal(sends, 2);
});
test('push keys survive restart and real Web Push encryption is generated without sending student notifications', async t => {
  const store = await isolatedStore(t); const { pushConfiguration, validateSubscription } = await import('../services/reminders/delivery.js');
  process.env.WEB_PUSH_SUBJECT = 'https://pastq.example.test'; delete process.env.WEB_PUSH_PUBLIC_KEY; delete process.env.WEB_PUSH_PRIVATE_KEY;
  const first = pushConfiguration(); store.closeReminderStore(); assert.deepEqual(pushConfiguration(), first);
  const sub = validateSubscription(subscription());
  for (const endpoint of ['http://127.0.0.1/push', 'https://example.com/push', 'https://fcm.googleapis.com.evil.test/push', 'https://fcm.googleapis.com:8443/push']) assert.throws(() => validateSubscription({ ...sub, endpoint }));
  assert.throws(() => validateSubscription({ ...sub, keys: { ...sub.keys, p256dh: 'bad' } }));
  const details = webpush.generateRequestDetails(sub, JSON.stringify({ title: 'Scholar', body: 'Study time' }), { vapidDetails: first });
  assert.equal(details.headers['Content-Encoding'], 'aes128gcm'); assert.ok(Buffer.isBuffer(details.body)); assert.equal(details.body.includes('Study time'), false);
});
test('a test notification reaches only an opted-in owned device and cleans expired connections', async t => {
  const store = await isolatedStore(t), { sendTestReminder } = await import('../services/reminders/delivery.js');
  const device = subscription('personal-device'); store.saveSubscription('student-a', device); store.saveSettings('student-a', settings()); let sent = 0;
  const send = async (target, payload) => { sent++; assert.equal(target.endpoint, device.endpoint); assert.equal(payload.tag, 'pastq-test'); };
  await sendTestReminder('student-a', device.endpoint, send); assert.equal(sent, 1);
  await assert.rejects(sendTestReminder('student-b', device.endpoint, send)); assert.equal(sent, 1);
  store.saveSettings('student-a', { ...settings(), enabled: false }); await assert.rejects(sendTestReminder('student-a', device.endpoint, send)); assert.equal(sent, 1);
  store.saveSettings('student-a', settings()); await assert.rejects(sendTestReminder('student-a', device.endpoint, async () => { throw Object.assign(new Error('Expired'), { statusCode: 410 }); }), error => error.status === 410); assert.equal(store.subscriptions('student-a').length, 0);
});
test('authenticated reminder API isolates accounts and requires a connected device before opt-in', async t => {
  const store = await isolatedStore(t); process.env.NODE_ENV = 'test'; delete process.env.AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT; process.env.SESSION_OWNER_HMAC_SECRET = 'reminder-route-test-key';
  const provider = http.createServer((req, res) => { const user = req.headers.authorization?.replace('Bearer ', ''); res.setHeader('Content-Type', 'application/json'); if (!['student-a', 'student-b'].includes(user)) { res.writeHead(401); res.end('{}'); } else res.end(JSON.stringify({ id: user, email: `${user}@example.test`, user_metadata: {}, app_metadata: {} })); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); process.env.SUPABASE_URL = `http://127.0.0.1:${provider.address().port}`; process.env.SUPABASE_ANON_KEY = 'test-placeholder';
  const { default: routes } = await import('../routes/reminders.js'); const app = express(); app.use(express.json({ limit: '64kb' })); app.use('/api/reminders', routes);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); });
  const base = `http://127.0.0.1:${server.address().port}/api/reminders`;
  const call = (suffix, user = 'student-a', method = 'GET', body) => fetch(base + suffix, { method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await call('', 'student-a', 'PUT', { enabled: true })).status, 409);
  assert.equal((await call('', 'student-a', 'PUT', { timezone: 'fake-zone' })).status, 400);
  const sub = subscription('owned'); assert.equal((await call('/subscription', 'student-a', 'PUT', sub)).status, 200);
  const enabled = await (await call('', 'student-a', 'PUT', { enabled: true })).json(); assert.equal(enabled.settings.enabled, true); assert.equal(enabled.ownerId, 'student-a'); assert.equal(enabled.push.devices.length, 1);
  assert.equal((await call('/subscription', 'student-b', 'DELETE', { endpoint: sub.endpoint })).status, 200);
  assert.equal((await (await call('')).json()).push.devices.length, 1);
  assert.deepEqual((await (await call('', 'student-b')).json()).push.devices, []);
  const today = new Date().toISOString(); assert.equal((await call('/activity', 'student-a', 'POST', { sessions: [activity('real-session', today)] })).status, 202);
  assert.equal((await (await call('')).json()).preview.studiedToday, true); assert.equal((await (await call('', 'student-b')).json()).preview.studiedToday, false);
  assert.equal(store.readSettings(crypto.createHmac('sha256', process.env.SESSION_OWNER_HMAC_SECRET).update('student-a').digest('base64url')).enabled, true);
});
