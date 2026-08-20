import fs from 'fs';
import { Mistral } from '@mistralai/mistralai';
import * as groqProvider from './groq.js';
import * as openrouterProvider from './openrouterProvider.js';
import {
  EXTRACT_PROMPT,
  ANSWER_KEY_PROMPT,
  buildMemoryBlock,
} from './prompts.js';
import { getSession, saveSession, updateProgress, getJobs, saveJobs } from './store.js';
import { syncSessionToSupabase } from './supabaseSync.js';
import {
  PROVIDER,
  IS_GROQ,
  IS_OPENROUTER,
  IS_HYBRID,
  MODELS,
  PRICING,
  USD_TO_NGN,
  CONCURRENCY,
  CIRCUIT_BREAKER_THRESHOLD,
  STRONG_FALLBACK_MODEL,
  pricingForModel,
  providerForStage,
  needsStrongExtract,
  heuristicPageType,
  refinePageType,
  isExplanationLikeQuestion,
} from './models.js';
import { normalizeQuestionMath } from './mathNormalize.js';
import { auditExtractedQuestions, optionCount } from './coherence.js';

/** After escalate: keep the version with more non-empty options when Q# matches. */
function mergePreferRicherOptions(cheapQs, strongQs) {
  const byNum = new Map();
  for (const q of cheapQs || []) {
    if (q?.questionNumber != null) byNum.set(Number(q.questionNumber), q);
  }
  return (strongQs || []).map((sq) => {
    const n = sq?.questionNumber != null ? Number(sq.questionNumber) : null;
    if (n == null || !byNum.has(n)) return sq;
    const cq = byNum.get(n);
    const so = optionCount(sq);
    const co = optionCount(cq);
    if (co > so) {
      console.log(
        `[escalate:merge] Q${n}: keeping cheap options (${co}) over strong (${so})`
      );
      return {
        ...sq,
        options: cq.options,
        question: String(sq.question || '').trim().length >= String(cq.question || '').trim().length
          ? sq.question
          : cq.question,
        needsReview: true,
        confidence: Math.min(sq.confidence ?? 1, cq.confidence ?? 1, 0.55),
      };
    }
    return sq;
  });
}

function resolvePageDataUrl(dataUrl, imagePath) {
  if (dataUrl && String(dataUrl).startsWith('data:')) return dataUrl;
  if (imagePath && fs.existsSync(imagePath)) {
    const buf = fs.readFileSync(imagePath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  return null;
}

/**
 * Ensure page has OCR markdown. Image uploads store dataUrl/imagePath but historically
 * skipped OCR before extract — which caused false "blank page" skips.
 */
async function ensurePageOcr(sessionId, pageRef) {
  const pageNum = (pageRef?.index ?? 0) + 1;

  const need = await withSessionLock(sessionId, (s) => {
    const pg = s.pages.find((p) => p.id === pageRef.id) || s.pages[pageRef.index];
    if (!pg) return null;
    const existing = (pg.ocrMarkdown || '').trim();
    if (existing.length >= 8) {
      return { skip: true, ocrMarkdown: existing };
    }
    return {
      skip: false,
      dataUrl: pg.dataUrl || null,
      imagePath: pg.imagePath || null,
    };
  });

  if (!need) return '';
  if (need.skip) return need.ocrMarkdown;

  const url = resolvePageDataUrl(need.dataUrl, need.imagePath);
  if (!url) {
    console.warn(
      `[vision:ocr] Page ${pageNum}: no image data available for OCR (empty markdown)`
    );
    return '';
  }

  console.log(`[vision:ocr] Page ${pageNum}: running OCR (${PROVIDER})...`);
  const ocrResponse = await runOcrImage(url);
  const pages = ocrResponse?.pages || [];
  const md = String(pages[0]?.markdown || pages[0]?.text || '').trim();
  const pagesProcessed =
    ocrResponse?.usageInfo?.pagesProcessed ??
    ocrResponse?.usage_info?.pages_processed ??
    1;

  await withSessionLock(sessionId, (s) => {
    const pg = s.pages.find((p) => p.id === pageRef.id) || s.pages[pageRef.index];
    if (!pg) return;
    pg.ocrMarkdown = md;
    // Drop in-memory dataUrl after OCR to free RAM; imagePath remains on disk
    delete pg.dataUrl;
    addCost(s, {
      ocrPages: pagesProcessed,
      usage: ocrResponse?.usage,
      model: MODELS.ocr,
    });
  });

  console.log(
    `[vision:ocr] Page ${pageNum}: OCR complete — ${md.length} chars`
  );
  return md;
}

const MAX_RETRIES = 4;
const activeWorkers = new Set();
const abortedSessions = new Set();
/** Once OpenRouter auth fails in-process, skip further OR attempts (avoid 401 spam). */
let openRouterUnavailable = false;

// ── Per-Session Mutex (prevents concurrent read-modify-write corruption) ────
const sessionLocks = new Map();

class SessionMutex {
  constructor() { this._chain = Promise.resolve(); }
  acquire() {
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const prev = this._chain;
    this._chain = next;
    return prev.then(() => release);
  }
}

function getSessionLock(sessionId) {
  if (!sessionLocks.has(sessionId)) {
    sessionLocks.set(sessionId, new SessionMutex());
  }
  return sessionLocks.get(sessionId);
}

/**
 * Atomically read-modify-write a session under mutex.
 * `fn` receives the fresh session and must return it (or void).
 */
async function withSessionLock(sessionId, fn) {
  const lock = getSessionLock(sessionId);
  const release = await lock.acquire();
  try {
    const session = getSession(sessionId);
    if (!session) return null;
    const result = await fn(session);
    saveSession(session);
    return result;
  } finally {
    release();
  }
}

function abortSession(sessionId) {
  abortedSessions.add(sessionId);
  activeWorkers.delete(sessionId);
  console.log(`[vision] Session ${sessionId} cancelled/aborted`);
}

function abortAllSessions() {
  for (const id of activeWorkers) {
    abortedSessions.add(id);
  }
  activeWorkers.clear();
  console.log('[vision] All active sessions cancelled/aborted');
}

function getMistral() {
  return new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { retries = MAX_RETRIES, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const tooLarge = err?.status === 413 || msg.toLowerCase().includes('request too large');
      const retryable =
        !tooLarge &&
        (msg.toLowerCase().includes('timeout') ||
          msg.toLowerCase().includes('rate') ||
          msg.toLowerCase().includes('network') ||
          err?.status >= 500 ||
          err?.status === 429);
      if (!retryable || attempt === retries) break;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      console.warn(`[retry] ${label} attempt ${attempt + 1} failed: ${msg}; waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function parseJsonContent(content) {
  if (typeof content !== 'string') {
    if (Array.isArray(content)) {
      content = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
    } else {
      content = JSON.stringify(content);
    }
  }
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('Failed to parse model JSON');
  }
}

function ensureCost(session) {
  session.cost = session.cost || {
    ocrPages: 0,
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
    ngn: 0,
    cheapCalls: 0,
    strongCalls: 0,
    escalations: 0,
  };
  return session.cost;
}

function addCost(session, { ocrPages = 0, usage, model } = {}) {
  const cost = ensureCost(session);
  const rates = model ? pricingForModel(model) : PRICING.cheap;
  const ocrCost = ocrPages * PRICING.ocrPerPage;
  const inTok = usage?.promptTokens || 0;
  const outTok = usage?.completionTokens || 0;
  const chatCost = inTok * rates.chatInput + outTok * rates.chatOutput;
  cost.ocrPages += ocrPages;
  cost.inputTokens += inTok;
  cost.outputTokens += outTok;
  cost.usd = parseFloat((cost.usd + ocrCost + chatCost).toFixed(4));
  cost.ngn = parseFloat((cost.usd * USD_TO_NGN).toFixed(2));
  if (model === MODELS.strong || model === STRONG_FALLBACK_MODEL) cost.strongCalls += 1;
  else if (model) cost.cheapCalls += 1;
}

// ── OCR routing ─────────────────────────────────────────────────────────────

async function runOcrImage(dataUrl) {
  const ocrProvider = IS_HYBRID ? 'mistral' : providerForStage('ocr');

  if (ocrProvider === 'openrouter') {
    try {
      return await withRetry(
        async () => openrouterProvider.ocrImage(dataUrl, { model: MODELS.ocr }),
        { label: 'openrouter-ocr-image', retries: 1 }
      );
    } catch (err) {
      console.warn(`[vision] OpenRouter OCR failed (${err.message}), falling back to Mistral OCR`);
    }
  }
  if (ocrProvider === 'groq') {
    try {
      return await withRetry(
        async () => groqProvider.ocrImage(dataUrl, { model: MODELS.ocr }),
        { label: 'groq-ocr-image', retries: 1 }
      );
    } catch (err) {
      console.warn(`[vision] Groq OCR failed (${err.message}), falling back to Mistral OCR`);
    }
  }
  const mistral = getMistral();
  const mistralResult = await withRetry(
    async () =>
      mistral.ocr.process({
        model: 'mistral-ocr-latest',
        document: { type: 'image_url', imageUrl: dataUrl },
      }),
    { label: 'mistral-ocr-image' }
  );

  const md = String(mistralResult?.pages?.[0]?.markdown || '').trim();
  // Hybrid: if Mistral OCR returns empty, escalate to OpenRouter vision OCR
  if (IS_HYBRID && md.length < 8 && process.env.OPENROUTER_API_KEY && !openRouterUnavailable) {
    try {
      console.warn('[vision] Mistral OCR returned empty; retrying with OpenRouter vision OCR');
      return await withRetry(
        async () => openrouterProvider.ocrImage(dataUrl, { model: MODELS.strong }),
        { label: 'openrouter-ocr-fallback', retries: 1 }
      );
    } catch (err) {
      if (isOpenRouterAuthError(err)) openRouterUnavailable = true;
      console.warn(`[vision] OpenRouter OCR fallback failed (${err.message}); keeping Mistral result`);
    }
  }

  return mistralResult;
}

async function runOcrPdf(dataUrl) {
  const mistral = getMistral();
  return withRetry(
    async () =>
      mistral.ocr.process({
        model: 'mistral-ocr-latest',
        document: { type: 'document_url', documentUrl: dataUrl },
      }),
    { label: 'ocr-pdf' }
  );
}

// ── Chat JSON routing ───────────────────────────────────────────────────────

function isOpenRouterAuthError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    err?.status === 401 ||
    msg.includes('401') ||
    msg.includes('user not found') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('authentication')
  );
}

async function chatJson(system, user, { maxTokens = 8192, model = MODELS.cheap, label = 'chat-json' } = {}) {
  const stage = model === MODELS.strong ? 'strong' : 'cheap';
  const chatProvider = IS_HYBRID ? providerForStage(stage) : PROVIDER;
  const wantsStrong = model === MODELS.strong || stage === 'strong';
  const isEscalate = String(label).includes('escalate') || wantsStrong;

  if (chatProvider === 'openrouter') {
    if (openRouterUnavailable) {
      console.warn(
        `[escalate:call] OpenRouter unavailable → will use ${STRONG_FALLBACK_MODEL} for ${label}`
      );
    } else if (process.env.OPENROUTER_API_KEY) {
      try {
        console.log(
          `[escalate:call] request → provider=openrouter model=${model} label=${label}`
        );
        const t0 = Date.now();
        const response = await withRetry(
          async () => openrouterProvider.chatJson(system, user, { maxTokens, model }),
          { label: `${label}:${model}`, retries: 1 }
        );
        console.log(
          `[escalate:call] response ← provider=openrouter model=${response.model || model} ms=${Date.now() - t0} in=${response.usage?.promptTokens || 0} out=${response.usage?.completionTokens || 0}`
        );
        return { data: parseJsonContent(response.content), usage: response.usage, model: response.model };
      } catch (err) {
        if (isOpenRouterAuthError(err)) {
          openRouterUnavailable = true;
          console.warn(
            `[escalate:call] OpenRouter AUTH FAILED (${err.message}) → fallback ${STRONG_FALLBACK_MODEL}`
          );
        } else {
          console.warn(
            `[escalate:call] OpenRouter FAILED (${err.message}) → fallback Mistral`
          );
        }
      }
    } else {
      openRouterUnavailable = true;
      console.warn(
        `[escalate:call] OPENROUTER_API_KEY missing → fallback ${STRONG_FALLBACK_MODEL}`
      );
    }
  }
  if (chatProvider === 'groq') {
    if (process.env.GROQ_API_KEY) {
      try {
        if (isEscalate) {
          console.log(`[escalate:call] request → provider=groq model=${model} label=${label}`);
        }
        const response = await withRetry(
          async () => groqProvider.chatJson(system, user, { maxTokens, model }),
          { label: `${label}:${model}`, retries: 1 }
        );
        if (isEscalate) {
          console.log(
            `[escalate:call] response ← provider=groq model=${response.model || model}`
          );
        }
        return { data: parseJsonContent(response.content), usage: response.usage, model: response.model };
      } catch (err) {
        console.warn(`[vision] Groq chat failed (${err.message}), falling back to Mistral`);
      }
    } else {
      console.warn('[vision] GROQ_API_KEY not configured, using Mistral');
    }
  }

  const mistral = getMistral();
  let fallbackModel;
  if (model && String(model).startsWith('mistral')) {
    fallbackModel = model;
  } else if (wantsStrong) {
    fallbackModel = STRONG_FALLBACK_MODEL;
  } else {
    fallbackModel = 'mistral-small-latest';
  }
  if (isEscalate || wantsStrong) {
    console.log(
      `[escalate:call] request → provider=mistral model=${fallbackModel} label=${label}`
    );
  }
  const t1 = Date.now();
  const response = await withRetry(
    async () =>
      mistral.chat.complete({
        model: fallbackModel,
        temperature: 0,
        responseFormat: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
      }),
    { label: `${label}:${fallbackModel}` }
  );
  const content = response.choices?.[0]?.message?.content;
  if (isEscalate || wantsStrong) {
    console.log(
      `[escalate:call] response ← provider=mistral model=${fallbackModel} ms=${Date.now() - t1} in=${response.usage?.promptTokens || response.usage?.prompt_tokens || 0} out=${response.usage?.completionTokens || response.usage?.completion_tokens || 0}`
    );
  }
  return {
    data: parseJsonContent(content),
    usage: {
      promptTokens: response.usage?.promptTokens || response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completionTokens || response.usage?.completion_tokens || 0,
    },
    model: fallbackModel,
  };
}

// ── Question Grouping and Ordering ──────────────────────────────────────────

/**
 * Normalize exam paper titles so POST UME / POST-UTME / POSTUME variants group together.
 */
function normalizePaper(paper) {
  if (!paper) return null;
  let p = String(paper).trim().replace(/\s+/g, ' ');
  if (!p) return null;
  const upper = p.toUpperCase();
  // POSTUME / POST-UME / POST UTME / POST-UTME screening variants
  if (/POST[\s\-]?U\.?T?\.?M\.?E/.test(upper) || /POSTUME/.test(upper.replace(/[\s\-]/g, ''))) {
    if (/SCREENING|EXERCISE/.test(upper)) return 'POST UTME SCREENING';
    return 'POST UTME TEST';
  }
  return p;
}

/**
 * Deterministic year/paper from OCR text. Page text wins over LLM + session memory.
 */
function detectExamHeader(ocrMarkdown) {
  if (!ocrMarkdown) return null;
  const lines = String(ocrMarkdown)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50);

  const yearRe = /\b((?:19|20)\d{2})\b/;
  const examHint =
    /POST[\s\-]?U\.?T?\.?M\.?E|POSTUME|SCREENING\s+EXERCISE|SCREENING\s+TEST|UME\s+TEST|UTME/i;

  for (const line of lines) {
    if (!examHint.test(line) && !/UNIVERSITY|OBAFEMI|AWOLOWO/i.test(line)) continue;
    const ym = line.match(yearRe);
    if (!ym) continue;
    const year = ym[1];
    const yNum = Number(year);
    if (yNum < 1990 || yNum > 2035) continue;

    let paper = null;
    if (examHint.test(line) || /UNIVERSITY|OBAFEMI|AWOLOWO/i.test(line)) {
      // Prefer exam phrase from this line; fall back to canonical series name
      const postMatch = line.match(
        /POST[\s\-]?U\.?T?\.?M\.?E[\s\-]*(?:SCREENING(?:\s+(?:EXERCISE|TEST))?|TEST)?/i
      );
      if (postMatch) {
        paper = normalizePaper(postMatch[0]);
      } else if (/POSTUME/i.test(line.replace(/[\s\-]/g, ''))) {
        paper = normalizePaper(line);
      } else {
        paper = 'POST UTME TEST';
      }
    }
    return { year: String(year), paper };
  }

  // Broader scan: any line with year + nearby exam keyword in first 50 lines joined
  const head = lines.join('\n');
  const loose = head.match(
    /\b((?:19|20)\d{2})\b[^\n]{0,40}(?:POST[\s\-]?U\.?T?\.?M\.?E|POSTUME|SCREENING)|(?:POST[\s\-]?U\.?T?\.?M\.?E|POSTUME|SCREENING)[^\n]{0,40}\b((?:19|20)\d{2})\b/i
  );
  if (loose) {
    const year = loose[1] || loose[2];
    const yNum = Number(year);
    if (yNum >= 1990 && yNum <= 2035) {
      return { year: String(year), paper: 'POST UTME TEST' };
    }
  }
  return null;
}

function applyDetectedHeader(pageMeta, ocrMarkdown) {
  const detected = detectExamHeader(ocrMarkdown);
  const meta = pageMeta && typeof pageMeta === 'object' ? { ...pageMeta } : {};
  if (detected?.year) meta.year = detected.year;
  if (detected?.paper) meta.paper = detected.paper;
  else if (meta.paper) meta.paper = normalizePaper(meta.paper) || meta.paper;
  return { pageMeta: meta, detected };
}

function groupKey(year, paper) {
  return `${year || 'Unknown'}::${normalizePaper(paper) || paper || 'Default'}`;
}

function compareQuestions(a, b) {
  const pa = a.pageIndex != null ? Number(a.pageIndex) : 1e9;
  const pb = b.pageIndex != null ? Number(b.pageIndex) : 1e9;
  if (pa !== pb) return pa - pb;

  const na = a.questionNumber != null ? Number(a.questionNumber) : null;
  const nb = b.questionNumber != null ? Number(b.questionNumber) : null;
  if (na != null && nb != null && na !== nb) return na - nb;

  const oa = a.orderIndex != null ? Number(a.orderIndex) : Number(a.id) || 0;
  const ob = b.orderIndex != null ? Number(b.orderIndex) : Number(b.id) || 0;
  return oa - ob;
}

function sortQuestionsInPlace(questions, { renumber = false } = {}) {
  if (!Array.isArray(questions)) return [];
  questions.sort(compareQuestions);
  if (renumber) {
    questions.forEach((q, i) => {
      q.orderIndex = i + 1;
      q.id = i + 1;
    });
  }
  return questions;
}

function rebuildGroups(session, { renumber = false } = {}) {
  sortQuestionsInPlace(session.questions || [], { renumber });
  const map = new Map();
  for (const q of session.questions || []) {
    if (q.paper) q.paper = normalizePaper(q.paper) || q.paper;
    const y = q.year || 'Unknown';
    const p = q.paper || 'Default';
    const key = groupKey(y, p);
    if (!map.has(key)) {
      map.set(key, { year: y, paper: p, questionIds: [], count: 0 });
    }
    const g = map.get(key);
    g.questionIds.push(q.id);
    g.count += 1;
  }
  session.groups = Array.from(map.values()).sort((a, b) => {
    const ay = parseInt(a.year, 10) || 0;
    const by = parseInt(b.year, 10) || 0;
    if (by !== ay) return by - ay;
    return String(a.paper).localeCompare(String(b.paper));
  });
  return session.groups;
}

function bumpCount(memory, year, paper) {
  const key = groupKey(year, paper);
  memory.countsByGroup = memory.countsByGroup || {};
  memory.countsByGroup[key] = (memory.countsByGroup[key] || 0) + 1;
}

function letterToIndex(letter) {
  if (!letter) return null;
  const ch = String(letter).trim().toUpperCase().charAt(0);
  if (ch >= 'A' && ch <= 'E') return ch.charCodeAt(0) - 65;
  return null;
}

function applyAnswerKeys(session) {
  const keys = session.answerKeys || [];
  if (!keys.length) return;

  for (const q of session.questions || []) {
    if (q.correct !== null && q.correct !== undefined) continue;
    const qPaper = normalizePaper(q.paper) || q.paper;
    const matches = keys.filter((k) => {
      if (k.questionNumber == null || q.questionNumber == null) return false;
      if (Number(k.questionNumber) !== Number(q.questionNumber)) return false;
      if (k.year && q.year && String(k.year) !== String(q.year)) return false;
      const kPaper = normalizePaper(k.paper) || k.paper;
      if (kPaper && qPaper && String(kPaper).toLowerCase() !== String(qPaper).toLowerCase()) {
        return false;
      }
      return true;
    });
    if (matches.length === 1) {
      const m = matches[0];
      q.correct = m.correctIndex != null ? m.correctIndex : letterToIndex(m.correctLetter);
      if (q.correct != null) q.answerSource = 'answer_key';
    } else if (matches.length > 1) {
      q.needsReview = true;
    }
  }
}

function answerKeyDedupeKey(k) {
  const paper = normalizePaper(k.paper) || k.paper || 'Default';
  return `${k.year || 'Unknown'}::${paper}::Q${k.questionNumber}`;
}

/** Merge answer keys into session, deduping by year::paper::Q#. */
function mergeAnswerKeys(session, incoming) {
  if (!incoming?.length) return 0;
  session.answerKeys = session.answerKeys || [];
  const byKey = new Map();
  for (const k of session.answerKeys) {
    if (k.questionNumber == null) continue;
    byKey.set(answerKeyDedupeKey(k), k);
  }
  let added = 0;
  for (const k of incoming) {
    if (k.questionNumber == null) continue;
    const key = answerKeyDedupeKey(k);
    if (!byKey.has(key)) added += 1;
    byKey.set(key, {
      ...k,
      year: k.year ? String(k.year) : null,
      paper: normalizePaper(k.paper) || k.paper || null,
    });
  }
  session.answerKeys = Array.from(byKey.values());
  return added;
}

function detectNumberGaps(session) {
  const byGroup = new Map();
  for (const q of session.questions || []) {
    if (q.questionNumber == null) continue;
    const key = groupKey(q.year, q.paper);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(Number(q.questionNumber));
  }

  const followUps = [];
  for (const [key, nums] of byGroup.entries()) {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) {
        const [year, paper] = key.split('::');
        followUps.push({
          id: `gap-${key}-${sorted[i - 1]}-${sorted[i]}`,
          type: 'missing_questions',
          status: 'open',
          message: `${year} ${paper !== 'Default' ? 'Paper ' + paper + ' ' : ''}has a gap between Q${sorted[i - 1]} and Q${sorted[i]}. A page may be missing — please review or upload the missing page.`,
          meta: { year, paper, from: sorted[i - 1], to: sorted[i] },
          createdAt: Date.now(),
        });
      }
    }
  }
  return followUps;
}

function detectCountAnomalies(session) {
  const counts = Object.entries(session.memory?.countsByGroup || {});
  if (counts.length < 2) return [];

  const values = counts.map(([, c]) => c).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  if (median < 8) return [];

  const followUps = [];
  for (const [key, count] of counts) {
    if (count < median * 0.55) {
      const [year, paper] = key.split('::');
      followUps.push({
        id: `short-${key}`,
        type: 'count_anomaly',
        status: 'open',
        message: `${year}${paper && paper !== 'Default' ? ' Paper ' + paper : ''} has ${count} questions while most years average ~${Math.round(median)}. This may be incomplete.`,
        meta: { year, paper, count, median },
        createdAt: Date.now(),
      });
    }
  }
  return followUps;
}

function mergeFollowUps(session, incoming) {
  session.followUps = session.followUps || [];
  for (const f of incoming || []) {
    if (!f?.message) continue;
    const id = f.id || `fu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (session.followUps.some((x) => x.id === id || x.message === f.message)) continue;
    session.followUps.push({
      id,
      type: f.type || 'general',
      status: 'open',
      message: f.message,
      meta: f.meta || {},
      pageId: f.pageId || null,
      createdAt: Date.now(),
    });
  }
}

function nextQuestionId(session) {
  const max = (session.questions || []).reduce((m, q) => Math.max(m, Number(q.id) || 0), 0);
  return max + 1;
}

function cleanOptionPrefix(text) {
  const str = String(text || '').trim();
  if (!str) return '';
  // Check common prefixes cleanly without complex regex
  const prefixes = ['A.', 'B.', 'C.', 'D.', 'E.', 'A)', 'B)', 'C)', 'D)', 'E)', '(A)', '(B)', '(C)', '(D)', '(E)', 'a.', 'b.', 'c.', 'd.', 'e.', 'a)', 'b)', 'c)', 'd)', 'e)'];
  for (const p of prefixes) {
    if (str.startsWith(p)) {
      return str.slice(p.length).trim();
    }
  }
  return str;
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => cleanOptionPrefix(o))
    .filter(Boolean);
}

// ── Smart Contextual Inference (No Regex) ───────────────────────────────────

function getMostCommonSubject(session, year, paper) {
  const key = groupKey(year, paper);
  const counts = {};
  for (const q of session.questions || []) {
    if (groupKey(q.year, q.paper) !== key) continue;
    if (!q.subject || q.subject === 'General' || q.subject === 'Unknown') continue;
    counts[q.subject] = (counts[q.subject] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [subj, count] of Object.entries(counts)) {
    if (count > bestCount) { best = subj; bestCount = count; }
  }
  return best;
}

function autoAssignMissing(session, question) {
  if (!question.subject || question.subject === 'General' || question.subject === 'Unknown') {
    if (session.memory?.activeSubject) {
      question.subject = session.memory.activeSubject;
    } else if (session.subjectHint) {
      question.subject = session.subjectHint;
    } else {
      const groupSubj = getMostCommonSubject(session, question.year, question.paper);
      question.subject = groupSubj || 'General';
    }
  }

  // Never overwrite a year/paper already set from page header / pageMeta
  if (!question.year || question.year === 'Unknown') {
    if (session.memory?.activeYear) {
      question.year = session.memory.activeYear;
    }
  }

  if (!question.paper || question.paper === 'Default') {
    if (session.memory?.activePaper) {
      question.paper = normalizePaper(session.memory.activePaper) || session.memory.activePaper;
    }
  } else {
    question.paper = normalizePaper(question.paper) || question.paper;
  }
}

// ── Deduplication & Sequential Validation (Structural) ─────────────────────

function questionQualityScore(q) {
  const conf = typeof q.confidence === 'number' ? q.confidence : 0;
  const opts = Array.isArray(q.options) ? q.options.filter((o) => String(o || '').trim()).length : 0;
  const stemLen = String(q.question || '').trim().length;
  return conf * 10 + opts * 2 + Math.min(stemLen, 200) / 50;
}

function deduplicateQuestions(session) {
  const byKey = new Map();
  let removed = 0;

  for (const q of session.questions || []) {
    if (q.questionNumber == null) continue;
    if (q.paper) q.paper = normalizePaper(q.paper) || q.paper;
    const key = `${groupKey(q.year, q.paper)}::Q${q.questionNumber}`;
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(q);
  }

  for (const [, dups] of byKey) {
    if (dups.length <= 1) continue;

    // Prefer richer stem/options, then confidence
    dups.sort((a, b) => questionQualityScore(b) - questionQualityScore(a));
    const keep = dups[0];
    keep.needsReview = true;

    for (let i = 1; i < dups.length; i++) {
      const idx = session.questions.indexOf(dups[i]);
      if (idx >= 0) {
        session.questions.splice(idx, 1);
        removed++;
      }
    }
  }

  if (removed > 0) {
    console.log(`[dedup] resolved ${removed} duplicate question(s)`);
  }
  return removed;
}

function validateQuestionSequence(session) {
  const followUps = [];
  const byGroup = new Map();

  for (const q of session.questions || []) {
    if (q.questionNumber == null) continue;
    const key = groupKey(q.year, q.paper);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(q);
  }

  for (const [key, qs] of byGroup) {
    qs.sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));

    for (let i = 1; i < qs.length; i++) {
      const prev = Number(qs[i - 1].questionNumber);
      const curr = Number(qs[i].questionNumber);

      if (Math.abs(curr - prev) > 30 && qs[i - 1].pageIndex !== qs[i].pageIndex) {
        const [year, paper] = key.split('::');
        followUps.push({
          id: `seq-anomaly-${key}-${prev}-${curr}`,
          type: 'sequence_anomaly',
          status: 'open',
          message: `${year}${paper !== 'Default' ? ' Paper ' + paper : ''}: Large jump from Q${prev} to Q${curr}. Please verify page ordering.`,
          meta: { year, paper, from: prev, to: curr },
        });
      }
    }
  }

  return followUps;
}

// ── Cross-Page Stitching ────────────────────────────────────────────────────

function stitchContinuation(session, pageIndex, extracted) {
  const memory = session.memory;
  const out = [];
  let nextId = nextQuestionId(session);
  let nextOrder =
    (session.questions || []).reduce((m, q) => Math.max(m, Number(q.orderIndex) || 0), 0) + 1;

  const pageYear = extracted?.pageMeta?.year ? String(extracted.pageMeta.year) : null;
  const pagePaper = extracted?.pageMeta?.paper
    ? normalizePaper(extracted.pageMeta.paper) || String(extracted.pageMeta.paper)
    : null;

  // Only advance sticky memory when this page has an explicit header/year
  if (pageYear) memory.activeYear = pageYear;
  if (pagePaper) memory.activePaper = pagePaper;
  if (extracted?.pageMeta?.subject) memory.activeSubject = String(extracted.pageMeta.subject);

  let list = Array.isArray(extracted?.questions) ? [...extracted.questions] : [];
  list.sort((a, b) => {
    const na = a?.questionNumber != null ? Number(a.questionNumber) : null;
    const nb = b?.questionNumber != null ? Number(b.questionNumber) : null;
    if (na != null && nb != null) return na - nb;
    return 0;
  });

  list.forEach((raw, idxOnPage) => {
    let qText = String(raw.question || '').trim();
    let options = normalizeOptions(raw.options);
    const isCont =
      Boolean(raw.isContinuation) || (Boolean(extracted?.pageMeta?.isContinuation) && idxOnPage === 0);

    if (isCont && memory.openQuestion) {
      const open = memory.openQuestion;
      const merged = {
        ...open,
        question: [open.question, qText].filter(Boolean).join('\n').trim(),
        options:
          options.length > (open.options?.length || 0)
            ? options
            : [...(open.options || []), ...options.filter((o) => !(open.options || []).includes(o))],
        correct: raw.correct != null ? raw.correct : open.correct,
        explanation: raw.explanation || open.explanation || '',
        continuesToPage: pageIndex,
        incomplete: Boolean(raw.incomplete),
        needsReview: Boolean(raw.needsReview || open.needsReview),
      };
      const existingIdx = session.questions.findIndex((q) => q.id === open.id);
      if (existingIdx >= 0) {
        session.questions[existingIdx] = {
          ...session.questions[existingIdx],
          ...merged,
          options: normalizeOptions(merged.options),
        };
        memory.openQuestion = merged.incomplete ? { ...session.questions[existingIdx] } : null;
      } else {
        if (merged.orderIndex == null) merged.orderIndex = nextOrder++;
        out.push(merged);
        memory.openQuestion = merged.incomplete ? { ...merged } : null;
      }
      return;
    }

    // Prefer per-question → pageMeta (header) → memory fallback (continuations only)
    const year = raw.year || pageYear || memory.activeYear || null;
    const paper =
      normalizePaper(raw.paper) ||
      pagePaper ||
      normalizePaper(memory.activePaper) ||
      memory.activePaper ||
      null;
    const subject = raw.subject || extracted?.pageMeta?.subject || memory.activeSubject || session.subjectHint || 'General';
    const id = nextId++;
    const orderIndex = nextOrder++;

    const q = {
      id,
      orderIndex,
      subject,
      question: qText,
      options: options.length ? options : ['', '', '', ''],
      correct: raw.correct === undefined ? null : raw.correct,
      explanation: raw.explanation || '',
      year: year ? String(year) : null,
      paper: paper ? String(paper) : null,
      questionNumber: raw.questionNumber ?? null,
      pageIndex,
      pageOrder: idxOnPage,
      continuesFromPage: isCont ? pageIndex - 1 : null,
      continuesToPage: null,
      sourceType: 'question',
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.7,
      needsReview: Boolean(raw.needsReview) || options.length < 2,
      incomplete: Boolean(raw.incomplete),
    };
    normalizeQuestionMath(q);

    autoAssignMissing(session, q);

    if (memory.activeYear == null && q.year) memory.activeYear = String(q.year);
    if (memory.activePaper == null && q.paper) memory.activePaper = String(q.paper);
    if (memory.activeSubject == null && subject && subject !== 'General') memory.activeSubject = subject;

    if (q.questionNumber != null) {
      memory.recentQuestionNumbers = [
        ...(memory.recentQuestionNumbers || []).slice(-20),
        q.questionNumber,
      ];
    }
    bumpCount(memory, q.year, q.paper);

    memory.openQuestion = q.incomplete ? { ...q } : null;
    out.push(q);
  });

  if (extracted?.openQuestionCarry) {
    const carry = extracted.openQuestionCarry;
    memory.openQuestion = {
      id: memory.openQuestion?.id || nextId++,
      orderIndex: memory.openQuestion?.orderIndex || nextOrder++,
      subject: carry.subject || memory.activeSubject || session.subjectHint || 'General',
      question: String(carry.question || ''),
      options: normalizeOptions(carry.options),
      correct: carry.correct ?? null,
      explanation: carry.explanation || '',
      year: carry.year || pageYear || memory.activeYear,
      paper: normalizePaper(carry.paper) || pagePaper || memory.activePaper,
      questionNumber: carry.questionNumber ?? null,
      pageIndex,
      incomplete: true,
      needsReview: true,
      sourceType: 'question',
    };
  }

  return out;
}

// ── Per-Page Execution ──────────────────────────────────────────────────────

async function extractQuestions(ocrMarkdown, memory, subjectHint, model = MODELS.cheap, label = 'extract') {
  const { data, usage, model: used } = await chatJson(
    EXTRACT_PROMPT,
    `${buildMemoryBlock(memory)}\nContext subject: ${subjectHint || 'Deduce from content'}\n\nFormat all mathematical, physical, and chemical formulas in standard LaTeX ($...$). Discard background noise from adjacent pages.\nCRITICAL: Discard any leading/trailing crop fragments that have no visible question number. Never attach orphan option text to a different question number.\nEvery MCQ must include ALL lettered options visible for that question (typically A–E). Do not drop an option because of diagonal wrap.\n\n--- OCR TRANSCRIPTION ---\n${ocrMarkdown.slice(0, 14000)}\n--- END ---`,
    { maxTokens: 8192, model, label }
  );
  return { data, usage, model: used };
}

async function extractAnswerKey(ocrMarkdown, memory) {
  const { data, usage, model } = await chatJson(
    ANSWER_KEY_PROMPT,
    `${buildMemoryBlock(memory)}\n\n--- OCR TRANSCRIPTION ---\n${ocrMarkdown.slice(0, 10000)}\n--- END ---`,
    { maxTokens: 4096, model: MODELS.cheap, label: 'answers' }
  );
  return { data, usage, model };
}

/**
 * Pure per-page extraction (no shared-session mutation).
 * Returns a pageResult for the worker to merge under withSessionLock.
 */
async function executePageExtraction(
  sessionId,
  pageRef,
  ocrMarkdown,
  pageIndex,
  subjectHint,
  memorySnapshot
) {
  const pageNum = (pageRef?.index ?? pageIndex ?? 0) + 1;
  const memory = memorySnapshot || {};
  const costAcc = { entries: [] };

  const trackCost = ({ usage, model, ocrPages = 0 }) => {
    costAcc.entries.push({ usage, model, ocrPages });
  };

  try {
    let md = ocrMarkdown || '';

    if (!md || md.length < 8) {
      console.log(`[vision:skip] Page ${pageNum} is empty/blank (<8 chars), skipping.`);
      return {
        pageType: 'blank',
        classifyConfidence: 0.99,
        skipStatus: 'skipped',
        skipReason: 'blank_or_negligible_text',
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }

    const heuristic = heuristicPageType(md);
    if (heuristic?.pageType === 'blank') {
      console.log(`[vision:heuristic] Page ${pageNum} skipped: ${heuristic.reason}`);
      return {
        pageType: 'blank',
        classifyConfidence: heuristic.confidence,
        skipStatus: 'skipped',
        skipReason: heuristic.reason,
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }
    // Explanations / solutions pages: skip before LLM so we don't mint fake MCQs
    if (heuristic?.pageType === 'explanation') {
      console.log(
        `[vision:heuristic] Page ${pageNum} marked explanation (${heuristic.reason}) — skipping question extract`
      );
      return {
        pageType: 'explanation',
        classifyConfidence: heuristic.confidence,
        skipStatus: 'skipped',
        skipReason: heuristic.reason,
        memoryUpdates: memory.answersSectionStarted ? {} : { answersSectionStarted: true },
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }

    // Compact answer keys: go straight to answer-key extract (no MCQ pass)
    if (heuristic?.pageType === 'answer_key') {
      console.log(
        `[vision:heuristic] Page ${pageNum} compact answer key (${heuristic.reason}) — answer-key path`
      );
      const memoryUpdates = { answersSectionStarted: true };
      const header = detectExamHeader(md);
      if (header?.year) memoryUpdates.activeYear = String(header.year);
      if (header?.paper) memoryUpdates.activePaper = normalizePaper(header.paper) || header.paper;

      console.log(`[vision:answers] Page ${pageNum}: Parsing answer keys (heuristic)...`);
      const { data: answers, usage: aUsage, model: aModel } = await extractAnswerKey(md, memory);
      trackCost({ usage: aUsage, model: aModel });
      const year = header?.year || answers?.year || memory.activeYear || null;
      const paper =
        normalizePaper(header?.paper || answers?.paper || memory.activePaper) || null;
      const answerKeys = (answers?.answers || []).map((a) => ({
        questionNumber: a.questionNumber,
        correctLetter: a.correctLetter,
        correctIndex: a.correctIndex ?? letterToIndex(a.correctLetter),
        year: year ? String(year) : null,
        paper,
        subject: answers?.subject || memory.activeSubject || null,
      }));
      return {
        pageType: 'answer_key',
        classifyConfidence: heuristic.confidence,
        answerKeys,
        memoryUpdates,
        followUps: answers?.followUps || [],
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }

    const effectiveSubjectHint = memory.activeSubject || subjectHint || null;
    console.log(
      `[vision:extract] Page ${pageNum}: Extracting questions with Mistral Small (subjectHint=${effectiveSubjectHint || 'auto'})...`
    );

    let { data: extracted, usage: eUsage, model: eModel } = await extractQuestions(
      md,
      memory,
      effectiveSubjectHint,
      MODELS.cheap
    );
    trackCost({ usage: eUsage, model: eModel });

    if (extracted?.reasoning) {
      console.log(
        `[vision:reasoning] Page ${pageNum}:\n  ${String(extracted.reasoning).split('\n').join('\n  ')}`
      );
    }

    let pageMeta = extracted?.pageMeta || {};
    const { pageMeta: overridden, detected } = applyDetectedHeader(pageMeta, md);
    pageMeta = overridden;
    if (extracted) extracted.pageMeta = pageMeta;
    if (detected?.year) {
      console.log(
        `[vision:header] Page ${pageNum}: OCR header year=${detected.year} paper=${detected.paper || '?'}`
      );
    }

    const refined = refinePageType(md, pageMeta, extracted);
    let pageType = refined.pageType;
    const classifyConfidence = refined.confidence ?? pageMeta.confidence ?? 0.9;
    if (refined.reason && refined.pageType !== pageMeta.pageType) {
      console.log(
        `[vision:classify:override] Page ${pageNum}: model="${pageMeta.pageType}" → "${pageType}" (${refined.reason})`
      );
    }
    if (refined.dropQuestions && extracted) {
      extracted.questions = [];
      extracted.openQuestionCarry = null;
    } else if (extracted?.questions?.length) {
      const before = extracted.questions.length;
      extracted.questions = extracted.questions.filter((q) => !isExplanationLikeQuestion(q));
      const dropped = before - extracted.questions.length;
      if (dropped > 0) {
        console.log(
          `[vision:filter] Page ${pageNum}: dropped ${dropped} explanation-like item(s) from extract`
        );
      }
      extracted.questions = extracted.questions.map(normalizeQuestionMath);
    }
    if (extracted?.pageMeta) extracted.pageMeta.pageType = pageType;

    // Structural coherence: drop orphan crop fragments, flag option-count outliers
    let coherence = { shouldEscalate: false, flags: [], missing: [] };
    if (pageType === 'question_content' && extracted?.questions?.length) {
      coherence = auditExtractedQuestions(extracted, { pageNum });
      extracted.questions = coherence.questions;
    }

    console.log(
      `[vision:classify] Page ${pageNum}: type="${pageType}", confidence=${classifyConfidence}, year=${pageMeta.year || '?'}, paper=${pageMeta.paper || '?'}, subject=${pageMeta.subject || '?'}`
    );

    const memoryUpdates = {};
    if (pageMeta.year) {
      memoryUpdates.activeYear = String(pageMeta.year);
      memoryUpdates.lastHeadings = [`year:${pageMeta.year}`];
    }
    if (pageMeta.paper) {
      memoryUpdates.activePaper = normalizePaper(pageMeta.paper) || String(pageMeta.paper);
      memoryUpdates.lastHeadings = [
        ...(memoryUpdates.lastHeadings || []),
        `paper:${memoryUpdates.activePaper}`,
      ];
    }
    if (pageMeta.subject) {
      memoryUpdates.activeSubject = String(pageMeta.subject);
      memoryUpdates.lastHeadings = [
        ...(memoryUpdates.lastHeadings || []),
        `subject:${pageMeta.subject}`,
      ];
    }

    if (pageType === 'blank' || pageType === 'cover_toc' || pageType === 'explanation') {
      console.log(`[vision:skip] Page ${pageNum} marked as ${pageType}, skipped.`);
      if (pageType === 'explanation') {
        memoryUpdates.answersSectionStarted = true;
      }
      return {
        pageType,
        classifyConfidence,
        skipStatus: 'skipped',
        skipReason: refined.reason || pageType,
        memoryUpdates,
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }

    if (pageType === 'unclear') {
      console.warn(`[vision:unclear] Page ${pageNum} marked as needs_input (unclear).`);
      const fu = {
        id: `unclear-${pageRef.id}`,
        type: 'unclear_image',
        message: `Page ${pageNum} is too blurry or damaged. Please upload a clearer photo of this page.`,
        meta: { pageIndex },
      };
      return {
        pageType,
        classifyConfidence,
        skipStatus: 'needs_input',
        followUps: [fu],
        followUpId: fu.id,
        memoryUpdates,
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }

    if (pageType === 'answer_key') {
      memoryUpdates.answersSectionStarted = true;
      console.log(`[vision:answers] Page ${pageNum}: Parsing answer keys...`);
      const { data: answers, usage: aUsage, model: aModel } = await extractAnswerKey(md, memory);
      trackCost({ usage: aUsage, model: aModel });

      if (answers?.reasoning) {
        console.log(
          `[vision:answers:reasoning] Page ${pageNum}:\n  ${String(answers.reasoning).split('\n').join('\n  ')}`
        );
      }

      const header = detectExamHeader(md);
      const year =
        header?.year ||
        answers?.year ||
        pageMeta.year ||
        memory.activeYear ||
        null;
      const paper =
        header?.paper ||
        normalizePaper(answers?.paper) ||
        normalizePaper(pageMeta.paper) ||
        normalizePaper(memory.activePaper) ||
        memory.activePaper ||
        null;

      if (year) memoryUpdates.activeYear = String(year);
      if (paper) memoryUpdates.activePaper = String(paper);

      const answerKeys = [];
      for (const a of answers?.answers || []) {
        answerKeys.push({
          questionNumber: a.questionNumber,
          correctLetter: a.correctLetter,
          correctIndex: a.correctIndex != null ? a.correctIndex : letterToIndex(a.correctLetter),
          year: year ? String(year) : null,
          paper: paper ? String(paper) : null,
          pageIndex,
        });
      }

      console.log(`[vision:answers] Page ${pageNum}: Saved ${answerKeys.length} answer keys.`);
      return {
        pageType,
        classifyConfidence,
        answerKeys,
        memoryUpdates,
        followUps: answers?.followUps || [],
        questionCount: 0,
        costEntries: costAcc.entries,
      };
    }

    // Selective escalation
    let modelPath = 'cheap';
    let escalateReason = null;
    const cheapSnapshot = extracted
      ? {
          questions: Array.isArray(extracted.questions)
            ? extracted.questions.map((q) => ({ ...q, options: [...(q.options || [])] }))
            : [],
        }
      : null;
    const gate = needsStrongExtract(md, { ...pageMeta, pageType }, extracted);
    const wantStrong = gate.yes || coherence.shouldEscalate;
    if (wantStrong) {
      escalateReason = gate.yes
        ? gate.reason
        : `coherence:${(coherence.flags || []).map((f) => `${f.action}:${(f.reasons || []).join('|')}`).join(';') || 'fail'}`;
      console.log(
        `[escalate] Page ${pageNum}: START reason="${escalateReason}" targetModel=${MODELS.strong} cheapQuestions=${extracted?.questions?.length || 0}`
      );
      modelPath = 'strong';
      try {
        const strong = await extractQuestions(
          md,
          memory,
          effectiveSubjectHint,
          MODELS.strong,
          'escalate-extract'
        );
        trackCost({ usage: strong.usage, model: strong.model });
        console.log(
          `[escalate] Page ${pageNum}: GOT model=${strong.model} questions=${strong.data?.questions?.length ?? 0}`
        );
        extracted = strong.data;
      } catch (escErr) {
        console.error(
          `[escalate] Page ${pageNum}: FAILED (${escErr?.message || escErr}) — keeping cheap extract`
        );
        extracted = cheapSnapshot
          ? { ...(extracted || {}), questions: cheapSnapshot.questions }
          : extracted;
        modelPath = 'cheap';
      }
      // Re-apply header override after strong extract
      if (extracted) {
        const re = applyDetectedHeader(extracted.pageMeta || pageMeta, md);
        extracted.pageMeta = re.pageMeta;
        pageMeta = re.pageMeta;
        if (re.detected?.year) memoryUpdates.activeYear = String(re.detected.year);
        if (re.detected?.paper) memoryUpdates.activePaper = re.detected.paper;
      }
      const reRefined = refinePageType(md, pageMeta, extracted);
      pageType = reRefined.pageType;
      if (reRefined.dropQuestions && extracted) {
        extracted.questions = [];
        extracted.openQuestionCarry = null;
      } else if (extracted?.questions?.length) {
        extracted.questions = extracted.questions
          .filter((q) => !isExplanationLikeQuestion(q))
          .map(normalizeQuestionMath);
        // Prefer fuller option sets from cheap when strong loses options
        if (cheapSnapshot?.questions?.length) {
          extracted.questions = mergePreferRicherOptions(
            cheapSnapshot.questions,
            extracted.questions
          );
        }
        coherence = auditExtractedQuestions(extracted, { pageNum });
        extracted.questions = coherence.questions;
        console.log(
          `[escalate] Page ${pageNum}: AFTER coherence kept=${extracted.questions.length} flags=${coherence.flags.length} missing=[${(coherence.missing || []).join(',')}]`
        );
      }
      if (pageType === 'explanation' || pageType === 'blank' || pageType === 'cover_toc') {
        console.log(`[vision:skip] Page ${pageNum} reclassified after escalate as ${pageType}`);
        if (pageType === 'explanation') memoryUpdates.answersSectionStarted = true;
        return {
          pageType,
          classifyConfidence: reRefined.confidence,
          skipStatus: 'skipped',
          skipReason: reRefined.reason || pageType,
          memoryUpdates,
          questionCount: 0,
          escalateReason,
          modelPath,
          costEntries: costAcc.entries,
        };
      }
    }

    const followUps = [...(extracted?.followUps || [])];
    if (coherence.missing?.length) {
      followUps.push({
        type: 'missing_question_numbers',
        message: `Page ${pageNum}: question number(s) ${coherence.missing.join(', ')} missing or dropped after coherence checks. Re-snap that region if needed.`,
        meta: { pageIndex, missing: coherence.missing },
      });
    }
    const shortOpts = (coherence.flags || []).filter((f) =>
      (f.reasons || []).some((r) => String(r).startsWith('option_count_'))
    );
    if (shortOpts.length) {
      followUps.push({
        type: 'option_count_mismatch',
        message: `Page ${pageNum}: option count differs from page modal for Q${shortOpts.map((f) => f.questionNumber).filter((n) => n != null).join(', Q')}. Review those questions.`,
        meta: { pageIndex, flags: shortOpts },
      });
    }

    return {
      pageType,
      classifyConfidence,
      extracted,
      memoryUpdates,
      followUps,
      questionCount: extracted?.questions?.length || 0,
      escalateReason,
      modelPath,
      costEntries: costAcc.entries,
    };
  } catch (err) {
    return {
      error: err?.message || String(err),
      questionCount: 0,
      costEntries: costAcc.entries,
    };
  }
}

function applyCostEntries(session, entries) {
  for (const e of entries || []) {
    addCost(session, e);
  }
}

function trimMemory(session) {
  const mem = session.memory;
  if (!mem) return;
  if (mem.recentQuestionNumbers && mem.recentQuestionNumbers.length > 30) {
    mem.recentQuestionNumbers = mem.recentQuestionNumbers.slice(-30);
  }
  if (mem.lastHeadings && mem.lastHeadings.length > 10) {
    mem.lastHeadings = mem.lastHeadings.slice(-10);
  }
}

// ── Concurrency Semaphore ───────────────────────────────────────────────────

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

// ── Master Session Worker ───────────────────────────────────────────────────

async function runSessionWorker(sessionId) {
  if (activeWorkers.has(sessionId)) return;
  activeWorkers.add(sessionId);

  try {
    let session = getSession(sessionId);
    if (!session) return;

    session.memory = session.memory || {};
    if (!('activeSubject' in session.memory)) {
      session.memory.activeSubject = null;
    }

    session.status = 'processing';

    // Recover orphaned pages left in 'processing' after crashes / incomplete runs
    let recovered = 0;
    for (const p of session.pages || []) {
      if (p.status === 'processing') {
        p.status = 'pending';
        recovered += 1;
      }
    }
    if (recovered) {
      console.warn(`[vision] Recovered ${recovered} orphaned processing page(s) → pending`);
    }
    updateProgress(session);
    saveSession(session);

    const providerLabel = IS_HYBRID ? `hybrid(mistral+openrouter)` : PROVIDER;
    const escalateNote = openRouterUnavailable
      ? `escalationProvider=${STRONG_FALLBACK_MODEL} (openrouter unavailable)`
      : IS_HYBRID
        ? `escalation=openrouter→${MODELS.strong} (fallback ${STRONG_FALLBACK_MODEL})`
        : '';
    console.log(
      `[vision] worker start ${sessionId} pages=${session.pages.length} provider=${providerLabel} concurrency=${CONCURRENCY}${escalateNote ? ' ' + escalateNote : ''}`
    );

    const sem = new Semaphore(CONCURRENCY);
    let consecutiveFailures = 0;
    let circuitBroken = false;

    while (true) {
      if (abortedSessions.has(sessionId)) {
        console.log(`[vision] Session ${sessionId} was aborted, stopping worker.`);
        return;
      }

      if (circuitBroken) {
        await withSessionLock(sessionId, (s) => {
          mergeFollowUps(s, [{
            id: `circuit-${sessionId}-${Date.now()}`,
            type: 'circuit_breaker',
            status: 'open',
            message: `Processing paused after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures. Please check your API keys/credits and resume.`,
            meta: { consecutiveFailures },
          }]);
        });
        console.error(`[circuit-breaker] ${sessionId}: ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures — pausing`);
        break;
      }

      // ── Atomically pick and mark batch pages as 'processing' ──────────
      // This prevents any page from being picked up twice by concurrent iterations.
      const batch = await withSessionLock(sessionId, (s) => {
        const pending = s.pages.filter((p) => p.status === 'pending');
        if (!pending.length) return [];
        const picked = pending.slice(0, CONCURRENCY);
        for (const p of picked) {
          const target = s.pages.find((sp) => sp.id === p.id);
          if (target) target.status = 'processing';
        }
        return picked.map((p) => ({ id: p.id, index: p.index }));
      });

      if (!batch || !batch.length) break;

      const promises = batch.map(async (pageRef) => {
        if (abortedSessions.has(sessionId)) return;
        await sem.acquire();
        try {
          if (abortedSessions.has(sessionId)) return;

          // ── OCR image pages if markdown missing (PDF path OCRs earlier) ──
          let ocrMarkdown = '';
          try {
            ocrMarkdown = await ensurePageOcr(sessionId, pageRef);
          } catch (ocrErr) {
            const msg = ocrErr?.message || String(ocrErr);
            console.error(`[vision:ocr] Page ${pageRef.index + 1} OCR failed: ${msg}`);
            await withSessionLock(sessionId, (s) => {
              const pg = s.pages.find((p) => p.id === pageRef.id) || s.pages[pageRef.index];
              if (!pg) return;
              pg.retryCount = (pg.retryCount || 0) + 1;
              pg.error = `OCR failed: ${msg}`;
              pg.status = pg.retryCount <= MAX_RETRIES ? 'pending' : 'failed';
              if (pg.status === 'failed') {
                consecutiveFailures++;
                if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) circuitBroken = true;
              }
              updateProgress(s);
            });
            return;
          }

          // ── Read the memory snapshot & page data under lock ──────────
          const pageCtx =
            await withSessionLock(sessionId, (s) => {
              const pg = s.pages.find((p) => p.id === pageRef.id) || s.pages[pageRef.index];
              if (!pg) return null;
              pg.retryCount = pg.retryCount || 0;
              pg.modelPath = pg.modelPath || 'cheap';
              // Prefer freshly written OCR; fall back to whatever was stored
              const md = (ocrMarkdown || pg.ocrMarkdown || '').trim() || pg.ocrMarkdown || '';
              return {
                ocrMarkdown: md,
                pageIndex: pg.index,
                subjectHint: s.memory?.activeSubject || s.subjectHint || null,
                memorySnapshot: JSON.parse(JSON.stringify(s.memory || {})),
              };
            });

          if (!pageCtx) return; // page disappeared
          const { pageIndex, subjectHint, memorySnapshot } = pageCtx;
          ocrMarkdown = pageCtx.ocrMarkdown || '';

          // ── Execute the slow LLM call OUTSIDE the lock ────────────
          // This is the critical design: the API call takes seconds,
          // so we don't hold the mutex during it.
          const pageResult = await executePageExtraction(
            sessionId, pageRef, ocrMarkdown, pageIndex, subjectHint, memorySnapshot
          );

          if (abortedSessions.has(sessionId)) return;

          // ── Merge results back into session UNDER lock ────────────
          await withSessionLock(sessionId, (s) => {
            const pg = s.pages.find((p) => p.id === pageRef.id) || s.pages[pageRef.index];
            if (!pg) return;

            if (pageResult.error) {
              applyCostEntries(s, pageResult.costEntries);
              pg.retryCount = (pg.retryCount || 0) + 1;
              pg.error = pageResult.error;
              if (pg.retryCount <= MAX_RETRIES) {
                pg.status = 'pending'; // will be retried in next iteration
                console.warn(`[vision:retry] Page ${pageRef.index + 1} failed. Will retry (attempt ${pg.retryCount}/${MAX_RETRIES}): ${pageResult.error}`);
              } else {
                pg.status = 'failed';
                consecutiveFailures++;
                console.error(`[vision:failed] Page ${pageRef.index + 1} failed permanently after ${MAX_RETRIES} attempts.`);
                if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) circuitBroken = true;
                mergeFollowUps(s, [{
                  id: `fail-${pg.id}`,
                  type: 'page_failed',
                  message: `Page ${pageRef.index + 1} failed after retries: ${pg.error}. You can resume to retry or replace this page.`,
                  pageId: pg.id,
                }]);
              }
            } else {
              consecutiveFailures = 0;

              applyCostEntries(s, pageResult.costEntries);
              if (pageResult.escalateReason) {
                ensureCost(s).escalations += 1;
              }

              // Apply all the results that processOnePage used to do
              pg.pageType = pageResult.pageType;
              pg.classifyConfidence = pageResult.classifyConfidence;
              pg.ocrMarkdown = pageResult.ocrMarkdownUpdate || pg.ocrMarkdown;
              if (pageResult.modelPath) pg.modelPath = pageResult.modelPath;
              if (pageResult.escalateReason) pg.escalateReason = pageResult.escalateReason;

              // Update memory from page results (in-page year/paper always win when present)
              if (pageResult.memoryUpdates) {
                const mu = pageResult.memoryUpdates;
                if (mu.activeYear) s.memory.activeYear = mu.activeYear;
                if (mu.activePaper) s.memory.activePaper = mu.activePaper;
                if (mu.activeSubject) s.memory.activeSubject = mu.activeSubject;
                if (mu.answersSectionStarted) s.memory.answersSectionStarted = true;
                if (mu.lastHeadings) {
                  s.memory.lastHeadings = [
                    ...(s.memory.lastHeadings || []).slice(-5),
                    ...mu.lastHeadings,
                  ].slice(-10);
                }
              }

              // Merge answer keys (deduped by year::paper::Q#)
              if (pageResult.answerKeys?.length) {
                mergeAnswerKeys(s, pageResult.answerKeys);
              }

              // Merge questions via stitchContinuation
              if (pageResult.extracted && pageResult.pageType !== 'answer_key') {
                const stitched = stitchContinuation(s, pg.index, pageResult.extracted);
                for (const q of stitched) {
                  if (!s.questions.some((x) => x.id === q.id)) {
                    s.questions.push(q);
                  } else {
                    const idx = s.questions.findIndex((x) => x.id === q.id);
                    s.questions[idx] = { ...s.questions[idx], ...q };
                  }
                }
              }

              // Merge follow-ups
              if (pageResult.followUps?.length) {
                mergeFollowUps(s, pageResult.followUps.map((f) => ({ ...f, pageId: pg.id })));
              }

              applyAnswerKeys(s);
              deduplicateQuestions(s);
              rebuildGroups(s);
              pg.status = pageResult.skipStatus || 'done';
              if (pageResult.skipReason) pg.skipReason = pageResult.skipReason;
              if (pageResult.followUpId) pg.followUpId = pageResult.followUpId;
            }

            trimMemory(s);
            updateProgress(s);
            rebuildGroups(s);
          });

          // Progressive Supabase sync (fire and forget, outside lock)
          const latestSession = getSession(sessionId);
          if (latestSession) {
            syncSessionToSupabase(latestSession).catch((err) =>
              console.warn('[supabase-sync] progressive sync error:', err.message)
            );
          }

          console.log(
            `[vision:done] Page ${pageRef.index + 1} DONE: ${pageResult.questionCount || 0} question(s) parsed. Session total: ${(getSession(sessionId)?.questions || []).length} questions across ${(getSession(sessionId)?.groups || []).length} group(s).`
          );
        } catch (err) {
          console.error(`[vision:error] Page ${pageRef.index + 1} error:`, err?.message || err);
          await withSessionLock(sessionId, (s) => {
            const pg = s.pages.find((p) => p.id === pageRef.id) || s.pages[pageRef.index];
            if (!pg) return;
            pg.retryCount = (pg.retryCount || 0) + 1;
            pg.error = err?.message || String(err);
            if (pg.retryCount <= MAX_RETRIES) {
              pg.status = 'pending';
            } else {
              pg.status = 'failed';
              consecutiveFailures++;
              if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) circuitBroken = true;
            }
            updateProgress(s);
          });
        } finally {
          sem.release();
        }
      });

      await Promise.all(promises);
    }

    session = getSession(sessionId);
    if (!session) return;

    // Any leftover 'processing' pages are incomplete — mark failed so status is honest
    for (const p of session.pages || []) {
      if (p.status === 'processing') {
        p.status = 'failed';
        p.error = p.error || 'Left in processing when worker exited';
      }
    }

    mergeFollowUps(session, detectNumberGaps(session));
    mergeFollowUps(session, detectCountAnomalies(session));
    mergeFollowUps(session, validateQuestionSequence(session));
    applyAnswerKeys(session);
    deduplicateQuestions(session);
    rebuildGroups(session, { renumber: true });
    trimMemory(session);
    updateProgress(session);

    const hasPending = session.pages.some((p) => p.status === 'pending');
    const hasProcessing = session.pages.some((p) => p.status === 'processing');
    const hasNeeds = session.pages.some((p) => p.status === 'needs_input');
    const hasFailed = session.pages.some((p) => p.status === 'failed');

    if (hasPending || hasProcessing) {
      session.status = 'processing';
    } else if (hasNeeds) {
      session.status = 'needs_input';
    } else if (hasFailed && session.questions.length === 0) {
      session.status = 'failed';
    } else if (hasFailed) {
      session.status = 'completed_with_errors';
    } else {
      session.status = 'completed';
    }

    const jobs = getJobs();
    jobs[sessionId] = {
      id: sessionId,
      status:
        session.status === 'completed' || session.status === 'completed_with_errors'
          ? 'completed'
          : session.status === 'failed'
            ? 'failed'
            : session.status === 'needs_input'
              ? 'needs_input'
              : 'processing',
      name: session.name,
      icon: session.icon,
      createdAt: session.createdAt,
      questions: session.questions,
      groups: session.groups,
      followUps: session.followUps,
      cost: session.cost,
      session: true,
    };
    saveJobs(jobs);
    saveSession(session);

    // Final comprehensive Supabase sync
    syncSessionToSupabase(session).catch((err) =>
      console.warn('[supabase-sync] final sync error:', err.message)
    );
  } finally {
    activeWorkers.delete(sessionId);
  }
}

function kickoffSession(sessionId) {
  setImmediate(() => {
    runSessionWorker(sessionId).catch((err) => console.error('Session worker fatal:', err));
  });
}

export {
  PROVIDER,
  PRICING,
  USD_TO_NGN,
  MAX_RETRIES,
  runOcrImage,
  runOcrPdf,
  kickoffSession,
  runSessionWorker,
  rebuildGroups,
  sortQuestionsInPlace,
  compareQuestions,
  applyAnswerKeys,
  detectNumberGaps,
  detectCountAnomalies,
  mergeFollowUps,
  letterToIndex,
  addCost,
  deduplicateQuestions,
  validateQuestionSequence,
  abortSession,
  abortAllSessions,
};
