import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataRoot } from '../vision/store.js';
let database;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function db() {
  if (database) return database;
  fs.mkdirSync(getDataRoot(), { recursive: true });
  const filename = path.join(getDataRoot(), 'study-sessions.db');
  database = new DatabaseSync(filename); if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS study_sessions(id TEXT PRIMARY KEY, host_key TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, visibility TEXT NOT NULL, status TEXT NOT NULL, logo TEXT, tag TEXT, starts_at TEXT, code_hash TEXT UNIQUE, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS study_sessions_public ON study_sessions(visibility,status,starts_at);
    CREATE TABLE IF NOT EXISTS study_memberships(owner_key TEXT NOT NULL, session_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY(owner_key,session_id));
    CREATE INDEX IF NOT EXISTS study_memberships_session ON study_memberships(session_id);`);
  return database;
}
const codeHash = value => crypto.createHash('sha256').update(value).digest('hex');
function publicView(row, joined = false) { return { id: row.id, title: row.title, kind: row.kind, visibility: row.visibility, status: row.status, logo: row.logo || null, tag: row.tag || null, startsAt: row.starts_at || null, joined }; }
export function publishSession(owner, input) {
  if (!input || typeof input.title !== 'string' || input.title.trim().length < 2 || input.title.trim().length > 120) fail('Give the session a name between 2 and 120 characters.');
  if (!['exam', 'tutorial'].includes(input.kind) || !['public', 'private'].includes(input.visibility)) fail('Choose an exam or tutorial and its visibility.');
  if (input.tag != null && (typeof input.tag !== 'string' || input.tag.length > 36)) fail('Keep the tag within 36 characters.');
  if (input.logo) { let url; try { url = new URL(input.logo); } catch { fail('Use an HTTPS logo URL.'); } if (url.protocol !== 'https:' || url.username || url.password || input.logo.length > 2048) fail('Use an HTTPS logo URL.'); }
  if (input.startsAt != null && (typeof input.startsAt !== 'string' || !Number.isFinite(Date.parse(input.startsAt)))) fail('Choose a valid session date.');
  const id = crypto.randomUUID(), code = input.visibility === 'private' ? crypto.randomBytes(8).toString('hex').toUpperCase() : null;
  db().prepare('INSERT INTO study_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, input.title.trim(), input.kind, input.visibility, 'upcoming', input.logo || null, input.tag?.trim() || null, input.startsAt ? new Date(input.startsAt).toISOString() : null, code ? codeHash(code) : null, new Date().toISOString());
  const session = publicView(db().prepare('SELECT * FROM study_sessions WHERE id=?').get(id));
  return { session, ...(code ? { inviteCode: code } : {}) };
}
export function publicSessions(owner, search = '') {
  return db().prepare("SELECT s.*,m.session_id AS joined FROM study_sessions s LEFT JOIN study_memberships m ON m.session_id=s.id AND m.owner_key=? WHERE s.visibility='public' AND s.status!='ended' AND instr(lower(s.title||' '||coalesce(s.tag,'')),lower(?))>0 ORDER BY coalesce(s.starts_at,s.created_at),s.id LIMIT 100").all(owner, search.slice(0, 120)).map(row => publicView(row, Boolean(row.joined)));
}
export function joinedSessions(owner) {
  return db().prepare('SELECT s.* FROM study_sessions s JOIN study_memberships m ON m.session_id=s.id WHERE m.owner_key=? ORDER BY m.joined_at DESC LIMIT 100').all(owner).map(row => publicView(row, true));
}
function join(owner, row) {
  if (!row) fail('Session not found. Check the code with your tutor.', 404);
  if (row.status === 'ended') fail('This session has ended.', 409);
  db().prepare('INSERT OR IGNORE INTO study_memberships VALUES(?,?,?)').run(owner, row.id, new Date().toISOString());
  return publicView(row, true);
}
export function joinPublicSession(owner, id) { return join(owner, db().prepare("SELECT * FROM study_sessions WHERE id=? AND visibility='public'").get(id)); }
export function joinPrivateSession(owner, input) {
  const code = typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!/^[A-F0-9]{16}$/.test(code)) fail('Enter the 16-character code from your tutor.');
  return join(owner, db().prepare("SELECT * FROM study_sessions WHERE code_hash=? AND visibility='private'").get(codeHash(code)));
}
export function endSession(owner, id) {
  const changed = db().prepare("UPDATE study_sessions SET status='ended' WHERE id=? AND host_key=?").run(id, owner).changes;
  if (!changed) fail('Session not found.', 404);
}
export function closeDiscoverStore() { database?.close(); database = undefined; }
