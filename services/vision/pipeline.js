/**
 * Vision pipeline worker (built for tens of thousands of pages).
 *
 *   ingest → page transcription (one page per call, shared adaptive scheduler)
 *   → structure pass over per-page headings (text-only, windowed)
 *   → assembly → model adjudication of conflicts → library
 *
 * Per-page work touches only small SQLite rows (pageStore.js); the session
 * file is written at stage boundaries and for periodic cost flushes.
 *
 * Failure handling is explicit, never a silent substitute:
 * - transient provider errors retry with backoff (rate limits also shrink the
 *   global concurrency and honour Retry-After);
 * - auth / credit errors pause the session until a human fixes them;
 * - output that still breaks its contract after repair turns fails that unit
 *   with the exact problems recorded; resume retries it.
 */
import { getSession, updateProgress, getJobs, saveJobs } from './store.js';
import * as pageStore from './pageStore.js';
import { resolveVisionModel, costUsd, ModelConfigError } from './modelRegistry.js';
import { ProviderError } from './openrouterProvider.js';
import { schedule, recordSuccess, recordRateLimit, recordCongestion } from './scheduler.js';
import { transcribePage } from './pageVision.js';
import { cropPageFigures } from './figures.js';
import { buildNodes, buildStructure, applySections } from './structure.js';
import { assembleSession } from './assemble.js';
import { adjudicateConflicts } from './adjudicate.js';
import { appendSessionEvent } from './events.js';
import { syncSessionToLibrary } from '../library/librarySync.js';

const PAGE_ATTEMPTS = Number(process.env.VISION_PAGE_ATTEMPTS || 3);
const TRANSIENT_RETRIES = Number(process.env.VISION_TRANSIENT_RETRIES || 8);
const COST_FLUSH_MS = 30000;
const INGEST_POLL_MS = 3000;
const SKIPPED_PAGE_TYPES = new Set(['blank', 'front_matter']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry transient provider failures; everything else propagates immediately. */
async function withTransientRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      recordSuccess();
      return out;
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= TRANSIENT_RETRIES) throw err;
      if (err.kind === 'rate_limit') recordRateLimit(err.retryAfter);
      else if (err.kind === 'network' || err.kind === 'timeout') recordCongestion();
      const delay = err.retryAfter ? err.retryAfter * 1000 : Math.min(120000, 2000 * 2 ** attempt);
      console.warn(`[vision] ${label}: ${err.kind} (${err.message.slice(0, 160)}); retry ${attempt + 1}/${TRANSIENT_RETRIES} in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}

function addUsage(cost, usage, model) {
  cost.inputTokens = (cost.inputTokens || 0) + (usage?.promptTokens || 0);
  cost.outputTokens = (cost.outputTokens || 0) + (usage?.completionTokens || 0);
  cost.usd = Number(((cost.usd || 0) + costUsd(model, usage)).toFixed(6));
  cost.calls = (cost.calls || 0) + 1;
}

/** Replace the follow-ups a stage produced last time with its current ones. */
function replaceStageFollowUps(s, stage, followUps, mergeFollowUps) {
  s.followUps = (s.followUps || []).filter((f) => f.meta?.stage !== stage || f.status === 'resolved');
  mergeFollowUps(s, followUps.map((f) => ({ ...f, meta: { ...(f.meta || {}), stage } })));
}

/** Facts about individual pages (failures, unreadable parts, page problems) as follow-ups. */
function pageFollowUps(pages, results) {
  const out = [];
  for (const p of pages) {
    if (p.status === 'failed') {
      out.push({ id: `fail-${p.id}`, type: 'page_failed', pageId: p.id, message: `Page ${p.index + 1} could not be transcribed after ${PAGE_ATTEMPTS} attempts: ${p.error}. Resume to retry, or replace the page image.` });
      continue;
    }
    const r = results.get(p.id);
    if (!r) continue;
    if (r.pageType === 'unreadable') out.push({ id: `unreadable-${p.id}`, type: 'unclear_image', pageId: p.id, message: `Page ${p.index + 1} could not be read. Upload a clearer scan or photo of it.` });
    const unclear = r.questions.filter((q) => q.legibility !== 'clear');
    if (unclear.length) {
      out.push({
        id: `unclear-${p.id}`, type: 'unclear_image', pageId: p.id,
        message: `Page ${p.index + 1}: ${unclear.map((q) => `${q.label ? `Q${q.label}` : 'continued question'} (${q.unclear.map((u) => u.note).join('; ') || q.legibility})`).join(', ')} could not be fully read. Check against the original or upload a clearer image.`,
        meta: { pageIndex: p.index, regions: unclear.map((q) => ({ label: q.label, unclear: q.unclear })) },
      });
    }
    for (const issue of r.pageIssues) {
      out.push({ id: `pageissue-${p.id}-${issue.issue}`, type: 'page_issue', pageId: p.id, message: `Page ${p.index + 1}: ${issue.issue.replaceAll('_', ' ')} — ${issue.note}`, meta: { pageIndex: p.index, issue: issue.issue } });
    }
  }
  return out;
}

/**
 * @param deps { withSessionLock, mergeFollowUps, isAborted }
 */
async function runVisionWorker(sessionId, deps) {
  const { withSessionLock, mergeFollowUps, isAborted } = deps;

  const pause = (reason, err) => withSessionLock(sessionId, (s) => {
    s.status = 'paused';
    s.pausedReason = reason;
    mergeFollowUps(s, [{ id: `paused-${reason}`, type: 'paused', message: err.message, meta: { stage: 'worker', reason } }]);
  });
  const attention = (id, type, message, stage) => withSessionLock(sessionId, (s) => {
    s.status = 'needs_attention';
    mergeFollowUps(s, [{ id, type, message, meta: { stage } }]);
  });

  let model;
  try {
    model = await resolveVisionModel();
  } catch (err) {
    if (err instanceof ModelConfigError) return pause('model_config', err);
    throw err;
  }

  pageStore.resetProcessing(sessionId);
  await withSessionLock(sessionId, (s) => {
    s.status = 'processing';
    s.pausedReason = null;
    s.model = model.id;
    s.followUps = (s.followUps || []).filter((f) => f.meta?.stage !== 'worker' || f.status === 'resolved');
  });

  // Cost accumulates in memory and is flushed periodically, not per page.
  const pendingCost = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
  const flushCost = () => withSessionLock(sessionId, (s) => {
    s.cost = s.cost || {};
    for (const k of Object.keys(pendingCost)) {
      s.cost[k] = Number(((s.cost[k] || 0) + pendingCost[k]).toFixed(6));
      pendingCost[k] = 0;
    }
  });
  const costTimer = setInterval(() => { flushCost().catch(() => {}); }, COST_FLUSH_MS);

  let paused = null;
  // Continuous dispatch: one scheduler task per pending page, topped up as new
  // pages arrive (ingest, retries) — no round waits for its slowest page.
  // `waiting` counts tasks that have not yet claimed a page: a claimed page is
  // no longer pending, so only unclaimed tasks offset the pending count.
  let outstanding = 0;
  let waiting = 0;
  const inFlight = new Set();
  try {
    while (!isAborted(sessionId) && !paused) {
      const pending = pageStore.statusCounts(sessionId).pending;
      const toAdd = pending - waiting;
      for (let i = 0; i < toAdd; i++) {
        outstanding += 1;
        waiting += 1;
        let started = false;
        const task = schedule(() => { started = true; waiting -= 1; return transcribeNext(); })
          .finally(() => { if (!started) waiting -= 1; outstanding -= 1; inFlight.delete(task); });
        inFlight.add(task);
      }
      if (!outstanding && !pending && getSession(sessionId)?.ingest?.status !== 'running') break;
      await Promise.race([sleep(INGEST_POLL_MS), ...inFlight]);
    }
    await Promise.all(inFlight);
  } finally {
    clearInterval(costTimer);
    await flushCost();
  }

  async function transcribeNext() {
    if (paused || isAborted(sessionId)) return;
    const [page] = pageStore.claimPending(sessionId, 1);
    if (!page) return;
    const label = `page ${page.index + 1}`;
    try {
      const neighbours = { prev: pageStore.getPageByIndex(sessionId, page.index - 1), next: pageStore.getPageByIndex(sessionId, page.index + 1) };
      let out = await withTransientRetry(() => transcribePage({ page, neighbours, model }), label);
      // An empty page is a claim worth confirming: an independent second read
      // either agrees (the page really is empty) or finds what the first missed.
      const items = (r) => r.questions.length + r.answers.length + r.explanations.length;
      if (!items(out.result)) {
        const second = await withTransientRetry(() => transcribePage({
          page, neighbours, model,
          note: `A first reading reported this page as "${out.result.pageType}" with no questions, answers or explanations. Check the whole page carefully, every column, and transcribe everything printed on it.`,
        }), `${label} second look`);
        // The kept reading's cost is added below with the page; count the other one here.
        if (items(second.result)) {
          console.warn(`[vision] ${label}: second look found ${items(second.result)} item(s) the first reading missed`);
          addUsage(pendingCost, out.usage, model);
          out = second;
        } else {
          addUsage(pendingCost, second.usage, model);
        }
      }
      if (page.imagePath) await cropPageFigures(sessionId, page, out.result.questions);
      pageStore.saveResult(sessionId, page.id, out.result);
      pageStore.updatePage(page.id, {
        status: SKIPPED_PAGE_TYPES.has(out.result.pageType) ? 'skipped' : 'done',
        pageType: out.result.pageType, legibility: out.result.legibility, turns: out.turns,
        inspections: out.inspections.length, questions: out.result.questions.length, error: null,
      });
      addUsage(pendingCost, out.usage, model);
    } catch (err) {
      if (err instanceof ProviderError && err.pausesSession) {
        paused = err;
        pageStore.updatePage(page.id, { status: 'pending' });
        return;
      }
      if (err.usage) addUsage(pendingCost, err.usage, model);
      const attempts = (page.attempts || 0) + 1;
      pageStore.updatePage(page.id, { attempts, error: err.message, status: attempts < PAGE_ATTEMPTS ? 'pending' : 'failed' });
      console.error(`[vision] ${label} attempt ${attempts} failed: ${err.message}`);
    }
  }

  if (isAborted(sessionId)) return;
  if (paused) return pause(paused.kind, paused);

  // ── Structure pass over the per-page headings.
  const pages = pageStore.listPages(sessionId);
  const results = pageStore.loadResults(sessionId);
  const { nodes } = buildNodes(pages, results);
  let outline = { version: 4, organizedBy: null, documentTitle: null, sections: [], nodeToSection: {} };
  if (nodes.length) {
    try {
      const built = await withTransientRetry(() => buildStructure(nodes, model), 'structure');
      outline = built.outline;
      addUsage(pendingCost, built.usage, model);
    } catch (err) {
      if (err instanceof ProviderError && err.pausesSession) return pause(err.kind, err);
      return attention('structure', 'structure_failed', `The document's sections could not be mapped from the page headings: ${err.message}. Resume to retry.`, 'structure');
    }
  }
  await withSessionLock(sessionId, (s) => {
    s.outline = outline;
    s.followUps = (s.followUps || []).filter((f) => f.id !== 'structure');
    appendSessionEvent(s, { type: 'structure_built', nodes: nodes.length, sections: outline.sections.length, organizedBy: outline.organizedBy });
  });

  // ── Assembly, with model adjudication of conflicts.
  const tagged = applySections(pages, results, outline);
  const assembleNow = () => assembleSession({ ...getSession(sessionId), pages, outline }, tagged);
  let out = assembleNow();
  if (out.conflicts.length) {
    try {
      const { decisions, usage } = await withTransientRetry(() => adjudicateConflicts(out.conflicts, model), 'adjudication');
      addUsage(pendingCost, usage, model);
      await withSessionLock(sessionId, (s) => { s.adjudications = { ...(s.adjudications || {}), ...decisions }; });
      out = assembleNow();
    } catch (err) {
      if (err instanceof ProviderError && err.pausesSession) return pause(err.kind, err);
      await withSessionLock(sessionId, (s) => mergeFollowUps(s, [{ id: 'adjudication', type: 'conflicts_unresolved', message: `${out.conflicts.length} assembly conflict(s) could not be resolved automatically: ${err.message}. The affected questions are flagged for review. Resume to retry.`, meta: { stage: 'assembly' } }]));
    }
  }
  await flushCost();

  const session = await withSessionLock(sessionId, (s) => {
    Object.assign(s, { questions: out.questions, groups: out.groups, answerKeys: out.answerKeys, questionIdByKey: out.questionIdByKey });
    replaceStageFollowUps(s, 'assembly-result', [...out.followUps, ...pageFollowUps(pages, results)], mergeFollowUps);
    updateProgress(s);
    const counts = pageStore.statusCounts(sessionId);
    if (s.ingest?.status === 'running' || counts.pending || counts.processing) s.status = 'processing';
    else if (s.ingest?.status === 'failed' || counts.failed) s.status = s.questions.length ? 'completed_with_errors' : 'failed';
    else s.status = 'completed';
    return s;
  });
  if (session.status === 'processing') return;

  const jobs = getJobs();
  jobs[sessionId] = {
    id: sessionId, status: session.status === 'failed' ? 'failed' : 'completed', name: session.name, icon: session.icon,
    createdAt: session.createdAt, questionCount: session.questions.length, groups: session.groups, cost: session.cost, session: true,
  };
  saveJobs(jobs);

  const sync = await syncSessionToLibrary(getSession(sessionId));
  await withSessionLock(sessionId, (s) => {
    s.followUps = (s.followUps || []).filter((f) => f.id !== 'library-sync');
    if (!sync.synced && sync.error) mergeFollowUps(s, [{ id: 'library-sync', type: 'library_sync_failed', message: `Extraction finished, but publishing to the library failed: ${sync.error}. Resume to retry.`, meta: { stage: 'library' } }]);
  });
}

export { runVisionWorker };
