import webpush from 'web-push';
import crypto from 'node:crypto';
import * as store from './store.js';
import { planReminder } from './planner.js';
import { reminderArtwork } from './artwork.js';
export function pushConfiguration() {
  const subject = process.env.WEB_PUSH_SUBJECT || (process.env.FRONTEND_URL || '').split(',').map(value => value.trim()).find(value => value.startsWith('https://')) || '';
  if (!/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(subject)) return null;
  const keys = process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY ? { publicKey: process.env.WEB_PUSH_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_PRIVATE_KEY } : store.readVapid(() => webpush.generateVAPIDKeys());
  return { subject, ...keys };
}
export function validateSubscription(input) {
  const fail = () => { throw Object.assign(new Error('This device returned an invalid push subscription.'), { status: 400 }); };
  if (!input || typeof input.endpoint !== 'string' || input.endpoint.length > 2048) fail();
  let url; try { url = new URL(input.endpoint); } catch { fail(); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.notify.windows.com');
  if (!allowed || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash) fail();
  for (const [key, size] of [['p256dh', 65], ['auth', 16]]) if (typeof input.keys?.[key] !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(input.keys[key]) || Buffer.from(input.keys[key], 'base64url').length !== size) fail();
  try { crypto.ECDH.convertKey(Buffer.from(input.keys.p256dh, 'base64url'), 'prime256v1'); } catch { fail(); }
  return { endpoint: url.href, expirationTime: null, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}
export async function sendPush(subscription, payload) {
  const vapidDetails = pushConfiguration();
  if (!vapidDetails) throw new Error('Push delivery is not configured.');
  return webpush.sendNotification(subscription, JSON.stringify(payload), { vapidDetails, TTL: 3600, urgency: 'normal', timeout: 10000, topic: 'pastq-study' });
}
export async function sendTestReminder(owner, endpoint, send = sendPush) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) throw Object.assign(new Error('Connect this device before testing reminders.'), { status: 400 });
  if (!store.readSettings(owner).enabled) throw Object.assign(new Error('Enable study reminders before sending a test.'), { status: 409 });
  const device = store.subscriptions(owner).find(item => item.id === store.subscriptionId(endpoint));
  if (!device) throw Object.assign(new Error('Connect this device before testing reminders.'), { status: 404 });
  const plan = planReminder(store.readSettings(owner), store.readActivity(owner));
  try { await send(device, { title: 'Scholar is ready', body: 'Your study reminders are connected.', url: '/?reminder=study', tag: 'pastq-test', ...reminderArtwork(plan.mood) }); }
  catch (error) {
    if ([404, 410].includes(error.statusCode)) { store.removeSubscription(owner, device.id); throw Object.assign(new Error('This notification connection expired. Reopen this page and connect this device again.'), { status: 410 }); }
    throw Object.assign(new Error('The notification could not be delivered. Please try again shortly.'), { status: 502 });
  }
}
export async function dispatchDueReminders({ now = new Date(), send = sendPush } = {}) {
  let sent = 0, failed = 0;
  const owners = store.candidateOwners(now.getTime());
  for (let offset = 0; offset < owners.length; offset += 4) await Promise.all(owners.slice(offset, offset + 4).map(async owner => {
    store.markChecked(owner, now.getTime());
    const settings = store.readSettings(owner), plan = planReminder(settings, store.readActivity(owner), now);
    if (!plan.due || !store.claimDelivery(owner, plan.day, now.getTime())) return;
    let delivered = false;
    for (const subscription of store.subscriptions(owner)) {
      if (!store.readSettings(owner).enabled) break;
      try { await send(subscription, { title: plan.title, body: plan.body, url: plan.url, tag: `pastq-study-${plan.day}`, ...reminderArtwork(plan.mood) }); delivered = true; }
      catch (error) { if ([404, 410].includes(error.statusCode)) store.removeSubscription(owner, subscription.id); }
    }
    store.markDelivery(owner, plan.day, delivered);
    if (delivered) sent++; else failed++;
  }));
  return { sent, failed };
}
export function startReminderScheduler() {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { if (pushConfiguration()) { const result = await dispatchDueReminders(); if (result.failed) console.warn(`[reminders] ${result.failed} delivery checks failed; bounded retries scheduled`); } } catch (error) { console.error('[reminders] delivery check failed:', error.message); } finally { busy = false; } };
  const timer = setInterval(tick, 60000); timer.unref(); void tick(); return () => clearInterval(timer);
}
