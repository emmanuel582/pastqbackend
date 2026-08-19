import {  Mistral  } from '@mistralai/mistralai';
import * as groqProvider from './groq.js';
import * as openrouterProvider from './openrouterProvider.js';
import { 
  CLASSIFY_PROMPT,
  EXTRACT_PROMPT,
  ANSWER_KEY_PROMPT,
  buildMemoryBlock,
 } from './prompts.js';
import { getSession, saveSession, updateProgress, getJobs, saveJobs } from './store.js';
import { 
  PROVIDER,
  IS_GROQ,
  IS_OPENROUTER,
  MODELS,
  PRICING,
  USD_TO_NGN,
  pricingForModel,
  needsStrongExtract,
  heuristicPageType,
 } from './models.js';

const MAX_RETRIES = 4;
const activeWorkers = new Set();

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
      const tooLarge = err?.status === 413 || /request too large/i.test(msg);
      const retryable =
        !tooLarge &&
        (/timeout|429|500|502|503|504|ECONNRESET|ETIMEDOUT|network|rate/i.test(msg) ||
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
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
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
  if (model === MODELS.strong) cost.strongCalls += 1;
  else if (model) cost.cheapCalls += 1;
}

async function runOcrImage(dataUrl) {
  if (IS_OPENROUTER) {
    return withRetry(
      async () => openrouterProvider.ocrImage(dataUrl, { model: MODELS.ocr }),
      { label: 'openrouter-ocr-image' }
    );
  }
  if (IS_GROQ) {
    return withRetry(
      async () => groqProvider.ocrImage(dataUrl, { model: MODELS.ocr }),
      { label: 'groq-ocr-image' }
    );
  }
  const mistral = getMistral();
  return withRetry(
    async () =>
      mistral.ocr.process({
        model: MODELS.ocr,
        document: { type: 'image_url', imageUrl: dataUrl },
      }),
    { label: 'ocr-image' }
  );
}

async function runOcrPdf(dataUrl) {
  if (IS_OPENROUTER) {
    return withRetry(
      async () => openrouterProvider.ocrPdf(dataUrl, { model: MODELS.ocr }),
      { label: 'openrouter-ocr-pdf' }
    );
  }
  if (IS_GROQ) {
    return withRetry(
      async () => groqProvider.ocrPdf(dataUrl, { model: MODELS.ocr }),
      { label: 'groq-ocr-pdf' }
    );
  }
  const mistral = getMistral();
  return withRetry(
    async () =>
      mistral.ocr.process({
        model: MODELS.ocr,
        document: { type: 'document_url', documentUrl: dataUrl },
      }),
    { label: 'ocr-pdf' }
  );
}

async function chatJson(system, user, { maxTokens = 8192, model = MODELS.cheap, label = 'chat-json' } = {}) {
  if (IS_OPENROUTER) {
    const response = await withRetry(
      async () => openrouterProvider.chatJson(system, user, { maxTokens, model }),
      { label: `${label}:${model}` }
    );
    return { data: parseJsonContent(response.content), usage: response.usage, model: response.model };
  }
  if (IS_GROQ) {
    const response = await withRetry(
      async () => groqProvider.chatJson(system, user, { maxTokens, model }),
      { label: `${label}:${model}` }
    );
    return { data: parseJsonContent(response.content), usage: response.usage, model: response.model };
  }
  const mistral = getMistral();
  const response = await withRetry(
    async () =>
      mistral.chat.complete({
        model,
        temperature: 0,
        responseFormat: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
      }),
    { label: `${label}:${model}` }
  );
  const content = response.choices?.[0]?.message?.content;
  return { data: parseJsonContent(content), usage: response.usage, model };
}

function groupKey(year, paper) {
  return `${year || 'Unknown'}::${paper || 'Default'}`;
}

/** Stable reading order: page → printed Q number → extraction sequence. */
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
    const matches = keys.filter((k) => {
      if (k.questionNumber == null || q.questionNumber == null) return false;
      if (Number(k.questionNumber) !== Number(q.questionNumber)) return false;
      if (k.year && q.year && String(k.year) !== String(q.year)) return false;
      if (k.paper && q.paper && String(k.paper).toLowerCase() !== String(q.paper).toLowerCase()) return false;
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
          message: `${year} ${paper !== 'Default' ? 'Paper ' + paper + ' ' : ''}has a gap between Q${sorted[i - 1]} and Q${sorted[i]}. A page may be missing — can you upload the missing page?`,
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
        message: `${year}${paper && paper !== 'Default' ? ' Paper ' + paper : ''} has ${count} questions while most years average ~${Math.round(median)}. This looks incomplete — missing pages?`,
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

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => String(o || '').replace(/^\s*[A-Ea-e][\)\.\:\-]\s*/, '').trim())
    .filter(Boolean);
}

function stitchContinuation(session, pageIndex, extracted) {
  const memory = session.memory;
  const out = [];
  let nextId = nextQuestionId(session);
  let nextOrder =
    (session.questions || []).reduce((m, q) => Math.max(m, Number(q.orderIndex) || 0), 0) + 1;

  if (extracted?.pageMeta?.year) memory.activeYear = String(extracted.pageMeta.year);
  if (extracted?.pageMeta?.paper) memory.activePaper = String(extracted.pageMeta.paper);

  let list = Array.isArray(extracted?.questions) ? [...extracted.questions] : [];
  // Keep on-page order: prefer printed question numbers when present
  list.sort((a, b) => {
    const na = a?.questionNumber != null ? Number(a.questionNumber) : null;
    const nb = b?.questionNumber != null ? Number(b.questionNumber) : null;
    if (na != null && nb != null) return na - nb;
    return 0; // preserve model order otherwise
  });

  list.forEach((raw, idxOnPage) => {
    let qText = String(raw.question || '').trim();
    let options = normalizeOptions(raw.options);
    // Only the FIRST item can be a page-start continuation; later ones are new questions
    const isCont =
      !!raw.isContinuation || (!!extracted?.pageMeta?.isContinuation && idxOnPage === 0);

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
        incomplete: !!raw.incomplete,
        needsReview: !!(raw.needsReview || open.needsReview),
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

    const year = raw.year || extracted?.pageMeta?.year || memory.activeYear || null;
    const paper = raw.paper || extracted?.pageMeta?.paper || memory.activePaper || null;
    const id = nextId++;
    const orderIndex = nextOrder++;

    const q = {
      id,
      orderIndex,
      subject: raw.subject || session.subjectHint || 'General',
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
      needsReview: !!raw.needsReview || options.length < 2,
      incomplete: !!raw.incomplete,
    };

    if (memory.activeYear == null && year) memory.activeYear = String(year);
    if (memory.activePaper == null && paper) memory.activePaper = String(paper);

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
      subject: carry.subject || session.subjectHint || 'General',
      question: String(carry.question || ''),
      options: normalizeOptions(carry.options),
      correct: carry.correct ?? null,
      explanation: carry.explanation || '',
      year: carry.year || memory.activeYear,
      paper: carry.paper || memory.activePaper,
      questionNumber: carry.questionNumber ?? null,
      pageIndex,
      incomplete: true,
      needsReview: true,
      sourceType: 'question',
    };
  }

  return out;
}

async function classifyPage(ocrMarkdown, memory) {
  const { data, usage, model } = await chatJson(
    CLASSIFY_PROMPT,
    `${buildMemoryBlock(memory)}\n\n--- OCR ---\n${ocrMarkdown.slice(0, 8000)}\n--- END ---`,
    { maxTokens: 1024, model: MODELS.cheap, label: 'classify' }
  );
  return { data, usage, model };
}

async function extractQuestions(ocrMarkdown, memory, subjectHint, model = MODELS.cheap) {
  const { data, usage, model: used } = await chatJson(
    EXTRACT_PROMPT,
    `${buildMemoryBlock(memory)}\nSubject hint: ${subjectHint || 'unknown'}\n\nIMPORTANT: Prefer incomplete/needsReview over inventing options or answers. correct must be null unless clearly marked.\n\n--- OCR ---\n${ocrMarkdown.slice(0, 14000)}\n--- END ---`,
    { maxTokens: 8192, model, label: 'extract' }
  );
  return { data, usage, model: used };
}

async function extractAnswerKey(ocrMarkdown, memory) {
  const { data, usage, model } = await chatJson(
    ANSWER_KEY_PROMPT,
    `${buildMemoryBlock(memory)}\n\n--- OCR ---\n${ocrMarkdown.slice(0, 10000)}\n--- END ---`,
    { maxTokens: 4096, model: MODELS.cheap, label: 'answers' }
  );
  return { data, usage, model };
}

async function processOnePage(session, page) {
  page.status = 'processing';
  page.retryCount = page.retryCount || 0;
  page.modelPath = page.modelPath || 'cheap';
  saveSession(session);

  let ocrMarkdown = page.ocrMarkdown || '';

  // OCR once — never re-send the image for classify/extract
  if (!ocrMarkdown) {
    console.log(`[vision] page ${page.index + 1} OCR via ${PROVIDER} ${MODELS.ocr}`);
    if (!page.dataUrl && !page.imagePath) {
      throw new Error('Page has no image or OCR text');
    }
    let dataUrl = page.dataUrl;
    if (!dataUrl && page.imagePath) {
      const buf = fs.readFileSync(page.imagePath);
      dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    const ocrResponse = await runOcrImage(dataUrl);
    ocrMarkdown = (ocrResponse.pages || [])
      .map((p) => p.markdown || '')
      .filter(Boolean)
      .join('\n\n')
      .trim();
    const ocrPages =
      ocrResponse.usageInfo?.pagesProcessed ??
      ocrResponse.usage_info?.pages_processed ??
      (ocrResponse.pages?.length || 1);
    addCost(session, { ocrPages });
    page.ocrMarkdown = ocrMarkdown;
    delete page.dataUrl;
  }

  if (!ocrMarkdown || ocrMarkdown.length < 8) {
    page.status = 'skipped';
    page.pageType = 'blank';
    return;
  }

  // Free skip for obvious cover/blank — no chat spend
  const heuristic = heuristicPageType(ocrMarkdown);
  if (heuristic) {
    page.pageType = heuristic.pageType;
    page.classifyConfidence = heuristic.confidence;
    page.status = 'skipped';
    page.skipReason = heuristic.reason;
    return;
  }

  const { data: classified, usage: cUsage, model: cModel } = await classifyPage(
    ocrMarkdown,
    session.memory
  );
  addCost(session, { usage: cUsage, model: cModel });
  page.pageType = classified.pageType || 'question_content';
  page.classifyConfidence = classified.confidence ?? null;

  if (classified.detectedYear) {
    session.memory.activeYear = String(classified.detectedYear);
    session.memory.lastHeadings = [
      ...(session.memory.lastHeadings || []).slice(-9),
      `year:${classified.detectedYear}`,
    ];
  }
  if (classified.detectedPaper) {
    session.memory.activePaper = String(classified.detectedPaper);
    session.memory.lastHeadings = [
      ...(session.memory.lastHeadings || []).slice(-9),
      `paper:${classified.detectedPaper}`,
    ];
  }

  if (classified.pageType === 'blank' || classified.pageType === 'cover_toc') {
    page.status = 'skipped';
    return;
  }

  if (classified.pageType === 'unclear' || classified.needsClearerImage) {
    page.status = 'needs_input';
    const fu = {
      id: `unclear-${page.id}`,
      type: 'unclear_image',
      message: `Page ${page.index + 1} is too unclear to trust. Please upload a clearer photo of this page.`,
      pageId: page.id,
      meta: { pageIndex: page.index },
    };
    mergeFollowUps(session, [fu]);
    page.followUpId = fu.id;
    return;
  }

  if (classified.pageType === 'answer_key') {
    session.memory.answersSectionStarted = true;
    const { data: answers, usage: aUsage, model: aModel } = await extractAnswerKey(
      ocrMarkdown,
      session.memory
    );
    addCost(session, { usage: aUsage, model: aModel });
    const year = answers.year || session.memory.activeYear;
    const paper = answers.paper || session.memory.activePaper;
    for (const a of answers.answers || []) {
      session.answerKeys.push({
        questionNumber: a.questionNumber,
        correctLetter: a.correctLetter,
        correctIndex: a.correctIndex != null ? a.correctIndex : letterToIndex(a.correctLetter),
        year: year ? String(year) : null,
        paper: paper ? String(paper) : null,
        pageIndex: page.index,
      });
    }
    mergeFollowUps(
      session,
      (answers.followUps || []).map((f) => ({ ...f, pageId: page.id }))
    );
    applyAnswerKeys(session);
    page.status = 'done';
    return;
  }

  // Cheap extract first (text only — no image)
  let { data: extracted, usage: eUsage, model: eModel } = await extractQuestions(
    ocrMarkdown,
    session.memory,
    session.subjectHint,
    MODELS.cheap
  );
  addCost(session, { usage: eUsage, model: eModel });

  const gate = needsStrongExtract(ocrMarkdown, classified, extracted);
  if (gate.yes) {
    console.log(`[escalate] page ${page.index + 1}: ${gate.reason}`);
    ensureCost(session).escalations += 1;
    page.modelPath = 'strong';
    page.escalateReason = gate.reason;
    const strong = await extractQuestions(
      ocrMarkdown,
      session.memory,
      session.subjectHint,
      MODELS.strong
    );
    addCost(session, { usage: strong.usage, model: strong.model });
    extracted = strong.data;
  }

  const stitched = stitchContinuation(session, page.index, extracted);
  for (const q of stitched) {
    if (!session.questions.some((x) => x.id === q.id)) {
      session.questions.push(q);
    } else {
      const idx = session.questions.findIndex((x) => x.id === q.id);
      session.questions[idx] = { ...session.questions[idx], ...q };
    }
  }

  mergeFollowUps(
    session,
    (extracted.followUps || []).map((f) => ({ ...f, pageId: page.id }))
  );

  applyAnswerKeys(session);
  rebuildGroups(session);
  page.status = 'done';
}

async function runSessionWorker(sessionId) {
  if (activeWorkers.has(sessionId)) return;
  activeWorkers.add(sessionId);

  try {
    let session = getSession(sessionId);
    if (!session) return;

    session.status = 'processing';
    saveSession(session);
    console.log(`[vision] worker start ${sessionId} pages=${session.pages.length} provider=${PROVIDER}`);

    while (true) {
      session = getSession(sessionId);
      if (!session) break;

      const next = session.pages.find((p) => p.status === 'pending');
      if (!next) break;

      try {
        await processOnePage(session, next);
      } catch (err) {
        console.error(`Page ${next.index} error:`, err);
        next.retryCount = (next.retryCount || 0) + 1;
        next.error = err.message || String(err);
        if (next.retryCount <= MAX_RETRIES) {
          next.status = 'pending';
          await sleep(Math.min(30000, 1000 * Math.pow(2, next.retryCount)));
        } else {
          next.status = 'failed';
          mergeFollowUps(session, [
            {
              id: `fail-${next.id}`,
              type: 'page_failed',
              message: `Page ${next.index + 1} failed after retries: ${next.error}. You can resume to retry or replace this page.`,
              pageId: next.id,
            },
          ]);
        }
      }

      updateProgress(session);
      rebuildGroups(session);
      saveSession(session);
    }

    session = getSession(sessionId);
    if (!session) return;

    // final anomaly pass + lock final CBT order
    mergeFollowUps(session, detectNumberGaps(session));
    mergeFollowUps(session, detectCountAnomalies(session));
    applyAnswerKeys(session);
    rebuildGroups(session, { renumber: true });
    updateProgress(session);

    const hasPending = session.pages.some((p) => p.status === 'pending' || p.status === 'processing');
    const hasNeeds = session.pages.some((p) => p.status === 'needs_input');
    const hasFailed = session.pages.some((p) => p.status === 'failed');

    if (hasPending) {
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

    // compatibility: mirror into jobs.json shape for old client pollers
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
};
