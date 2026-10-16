import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataRoot } from '../vision/store.js';
import { defaultSettings } from './planner.js';
let database;
function db() {
  if (database) return database;
  fs.mkdirSync(getDataRoot(), { recursive: true });
  const filename = path.join(getDataRoot(), 'study-reminders.db');
  database = new DatabaseSync(filename);
  if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reminder_settings(owner_key TEXT PRIMARY KEY, settings TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS reminder_due ON reminder_settings(enabled,checked_at);
    CREATE TABLE IF NOT EXISTS reminder_subscriptions(endpoint_id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,subscription TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS reminder_owner ON reminder_subscriptions(owner_key);
    CREATE TABLE IF NOT EXISTS study_activity(owner_key TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_key,id));
    CREATE INDEX IF NOT EXISTS study_activity_owner ON study_activity(owner_key,at DESC);
    CREATE TABLE IF NOT EXISTS reminder_deliveries(owner_key TEXT NOT NULL,day TEXT NOT NULL,status TEXT NOT NULL,claimed_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(owner_key,day));
    CREATE TABLE IF NOT EXISTS reminder_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  return database;
}
export const readSettings = owner => { const row = db().prepare('SELECT settings FROM reminder_settings WHERE owner_key=?').get(owner); return row ? JSON.parse(row.settings) : defaultSettings(); };
export function saveSettings(owner, settings) { db().prepare('INSERT INTO reminder_settings(owner_key,settings,enabled) VALUES(?,?,?) ON CONFLICT(owner_key) DO UPDATE SET settings=excluded.settings,enabled=excluded.enabled,checked_at=0').run(owner, JSON.stringify(settings), Number(settings.enabled)); return settings; }
export const subscriptionId = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex');
export function saveSubscription(owner, subscription) {
  db().prepare('INSERT INTO reminder_subscriptions VALUES(?,?,?,?) ON CONFLICT(endpoint_id) DO UPDATE SET owner_key=excluded.owner_key,subscription=excluded.subscription,updated_at=excluded.updated_at').run(subscriptionId(subscription.endpoint), owner, JSON.stringify(subscription), Date.now());
  db().prepare('DELETE FROM reminder_subscriptions WHERE owner_key=? AND endpoint_id NOT IN(SELECT endpoint_id FROM reminder_subscriptions WHERE owner_key=? ORDER BY updated_at DESC LIMIT 10)').run(owner, owner);
}
export const subscriptions = owner => db().prepare('SELECT endpoint_id,subscription FROM reminder_subscriptions WHERE owner_key=?').all(owner).map(row => ({ id: row.endpoint_id, ...JSON.parse(row.subscription) }));
export const removeSubscription = (owner, id) => db().prepare('DELETE FROM reminder_subscriptions WHERE owner_key=? AND endpoint_id=?').run(owner, id);
export function saveActivity(owner, items) {
  db().exec('BEGIN IMMEDIATE');
  try { const insert = db().prepare('INSERT INTO study_activity VALUES(?,?,?,?) ON CONFLICT(owner_key,id) DO NOTHING'); for (const item of items) insert.run(owner, item.id, item.at, JSON.stringify(item)); db().prepare('DELETE FROM study_activity WHERE owner_key=? AND id NOT IN(SELECT id FROM study_activity WHERE owner_key=? ORDER BY at DESC LIMIT 120)').run(owner, owner); db().exec('COMMIT'); } catch (error) { db().exec('ROLLBACK'); throw error; }
}
export const readActivity = owner => db().prepare('SELECT data FROM study_activity WHERE owner_key=? ORDER BY at DESC LIMIT 120').all(owner).map(row => JSON.parse(row.data));
export function readVapid(makeKeys) { let row = db().prepare("SELECT value FROM reminder_meta WHERE key='vapid'").get(); if (!row) { db().prepare("INSERT OR IGNORE INTO reminder_meta VALUES('vapid',?)").run(JSON.stringify(makeKeys())); row = db().prepare("SELECT value FROM reminder_meta WHERE key='vapid'").get(); } return JSON.parse(row.value); }
export const candidateOwners = now => db().prepare('SELECT owner_key FROM reminder_settings WHERE enabled=1 AND checked_at<? AND EXISTS(SELECT 1 FROM reminder_subscriptions s WHERE s.owner_key=reminder_settings.owner_key) ORDER BY checked_at LIMIT 50').all(now - 60000).map(row => row.owner_key);
export const markChecked = (owner, now) => db().prepare('UPDATE reminder_settings SET checked_at=? WHERE owner_key=?').run(now, owner);
export function claimDelivery(owner, day, now) { return db().prepare("INSERT INTO reminder_deliveries VALUES(?,?,'pending',?,1) ON CONFLICT(owner_key,day) DO UPDATE SET status='pending',claimed_at=excluded.claimed_at,attempts=attempts+1 WHERE status!='sent' AND claimed_at<? AND attempts<3").run(owner, day, now, now - 15 * 60000).changes > 0; }
export const markDelivery = (owner, day, sent) => db().prepare('UPDATE reminder_deliveries SET status=? WHERE owner_key=? AND day=?').run(sent ? 'sent' : 'failed', owner, day);
export const lastDelivery = owner => db().prepare("SELECT day,status FROM reminder_deliveries WHERE owner_key=? AND status='sent' ORDER BY day DESC LIMIT 1").get(owner) || null;
export function closeReminderStore() { database?.close(); database = undefined; }
