/**
 * Global model-call scheduler shared by every session.
 *
 * Throughput at tens of thousands of pages comes from running many page calls
 * at once, but the safe level is not knowable in advance (provider capacity,
 * account rate limits). The limit adapts (AIMD): it grows by one after a run of
 * successes and is cut multiplicatively on a rate-limit response, and dispatch
 * pauses for the provider's Retry-After when one is given.
 */

const MIN = Number(process.env.VISION_MIN_CONCURRENCY || 4);
const MAX = Number(process.env.VISION_MAX_CONCURRENCY || 128);
const START = Math.min(MAX, Math.max(MIN, Number(process.env.VISION_CONCURRENCY || 24)));
const GROW_AFTER = Number(process.env.VISION_GROW_AFTER || 10);

const state = {
  limit: START,
  active: 0,
  queue: [],
  successes: 0,
  pausedUntil: 0,
  lastCutAt: 0,
  timer: null,
};

// A burst of simultaneous failures is one congestion event, not many.
const CUT_WINDOW_MS = 5000;
function cut() {
  if (Date.now() - state.lastCutAt < CUT_WINDOW_MS) return false;
  state.lastCutAt = Date.now();
  state.successes = 0;
  state.limit = Math.max(MIN, Math.floor(state.limit * 0.7));
  return true;
}

function pump() {
  if (state.timer) return;
  const wait = state.pausedUntil - Date.now();
  if (wait > 0) {
    state.timer = setTimeout(() => { state.timer = null; pump(); }, wait);
    return;
  }
  while (state.active < state.limit && state.queue.length) {
    const job = state.queue.shift();
    state.active += 1;
    job.run().then(job.resolve, job.reject).finally(() => {
      state.active -= 1;
      pump();
    });
  }
}

/** Run `fn` when a slot is free. Resolves/rejects with fn's outcome. */
function schedule(fn) {
  return new Promise((resolve, reject) => {
    state.queue.push({ run: fn, resolve, reject });
    pump();
  });
}

function recordSuccess() {
  state.successes += 1;
  if (state.successes >= GROW_AFTER && state.limit < MAX) {
    state.limit += 1;
    state.successes = 0;
    pump();
  }
}

/** Called on a 429: shrink the limit and honour Retry-After (seconds). */
function recordRateLimit(retryAfterSeconds) {
  cut();
  const pauseMs = Math.max(1000, (Number(retryAfterSeconds) || 0) * 1000);
  state.pausedUntil = Math.max(state.pausedUntil, Date.now() + pauseMs);
  console.warn(`[scheduler] rate limited: concurrency → ${state.limit}, pausing ${Math.round(pauseMs / 1000)}s`);
}

/**
 * Called on network failures/timeouts: treat them as congestion (the link or
 * the provider is saturated) and back off the same way, without a long pause.
 */
function recordCongestion() {
  const before = state.limit;
  if (!cut()) return;
  state.pausedUntil = Math.max(state.pausedUntil, Date.now() + 2000);
  console.warn(`[scheduler] network congestion: concurrency ${before} → ${state.limit}`);
}

function schedulerStats() {
  return { limit: state.limit, active: state.active, queued: state.queue.length, pausedUntil: state.pausedUntil };
}

export { schedule, recordSuccess, recordRateLimit, recordCongestion, schedulerStats };
