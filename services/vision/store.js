const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const JOBS_FILE = path.join(__dirname, '../../jobs.json');

for (const dir of [DATA_DIR, SESSIONS_DIR, PAGES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (!fs.existsSync(JOBS_FILE)) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify({}));
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function pageDir(sessionId) {
  const dir = path.join(PAGES_DIR, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getJobs() {
  return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function createEmptyMemory() {
  return {
    activeYear: null,
    activePaper: null,
    openQuestion: null,
    recentQuestionNumbers: [],
    answersSectionStarted: false,
    lastHeadings: [],
    countsByGroup: {},
  };
}

function createSession({ id, name, icon, subjectHint }) {
  const session = {
    id,
    name: name || 'New Material',
    icon: icon || '📖',
    subjectHint: subjectHint || null,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pages: [],
    questions: [],
    answerKeys: [],
    groups: [],
    followUps: [],
    memory: createEmptyMemory(),
    cost: {
      ocrPages: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      ngn: 0,
      cheapCalls: 0,
      strongCalls: 0,
      escalations: 0,
    },
    progress: {
      total: 0,
      done: 0,
      failed: 0,
      needsInput: 0,
      skipped: 0,
    },
  };
  saveSession(session);
  return session;
}

function getSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSession(session) {
  session.updatedAt = Date.now();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
  return session;
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function deleteSession(id) {
  const p = sessionPath(id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const dir = path.join(PAGES_DIR, id);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  }
}

function updateProgress(session) {
  const pages = session.pages || [];
  session.progress = {
    total: pages.length,
    done: pages.filter((p) => p.status === 'done').length,
    failed: pages.filter((p) => p.status === 'failed').length,
    needsInput: pages.filter((p) => p.status === 'needs_input').length,
    skipped: pages.filter((p) => p.status === 'skipped').length,
    pending: pages.filter((p) => p.status === 'pending' || p.status === 'processing').length,
  };
  return session.progress;
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    name: session.name,
    icon: session.icon,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    progress: session.progress,
    groups: session.groups,
    followUps: (session.followUps || []).filter((f) => f.status !== 'resolved'),
    allFollowUps: session.followUps || [],
    questions: session.questions,
    answerKeyCount: (session.answerKeys || []).length,
    memory: {
      activeYear: session.memory?.activeYear ?? null,
      activePaper: session.memory?.activePaper ?? null,
      answersSectionStarted: !!session.memory?.answersSectionStarted,
      countsByGroup: session.memory?.countsByGroup || {},
    },
    pages: (session.pages || []).map((p) => ({
      id: p.id,
      index: p.index,
      status: p.status,
      retryCount: p.retryCount || 0,
      pageType: p.pageType || null,
      error: p.error || null,
      followUpId: p.followUpId || null,
      filename: p.filename || null,
      modelPath: p.modelPath || null,
      escalateReason: p.escalateReason || null,
    })),
    cost: session.cost,
  };
}

module.exports = {
  JOBS_FILE,
  PAGES_DIR,
  getJobs,
  saveJobs,
  createEmptyMemory,
  createSession,
  getSession,
  saveSession,
  listSessions,
  deleteSession,
  updateProgress,
  publicSession,
  pageDir,
};
