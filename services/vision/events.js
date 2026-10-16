import fs from 'fs';
import path from 'path';
import { getDataRoot } from './store.js';

const MAX_SESSION_EVENTS = parseInt(process.env.VISION_MAX_SESSION_EVENTS || '5000', 10);

function logsDir() {
  const dir = path.join(getDataRoot(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function todayLogFile() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(logsDir(), `vision-${d}.jsonl`);
}

/**
 * Append structured event to session JSON + daily jsonl log.
 * @param {object} session
 * @param {object} event
 */
export function appendSessionEvent(session, event) {
  if (!session) return;
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    sessionId: session.id,
    ...event,
  };

  if (!Array.isArray(session.events)) session.events = [];
  session.events.push(entry);
  if (session.events.length > MAX_SESSION_EVENTS) {
    session.events = session.events.slice(-MAX_SESSION_EVENTS);
  }

  try {
    fs.appendFileSync(todayLogFile(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.warn('[vision:events] jsonl append failed:', err?.message || err);
  }
}

/**
 * Read recent lines from vision jsonl logs.
 * @param {{ limit?: number; sessionId?: string }} [opts]
 */
export function readOpsLogs(opts = {}) {
  const limit = opts.limit ?? 200;
  const sessionId = opts.sessionId;
  const dir = logsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('vision-') && f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const events = [];
  for (const file of files) {
    if (events.length >= limit) break;
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (sessionId && ev.sessionId !== sessionId) continue;
        events.unshift(ev);
        if (events.length >= limit) break;
      } catch {
        /* skip bad line */
      }
    }
  }

  return events.slice(-limit);
}
