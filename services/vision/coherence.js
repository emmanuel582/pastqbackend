/**
 * Post-extract coherence checks — catch silent mislabels the model self-confidence misses.
 * Example failure: orphan crop fragment ("between the value of exports…") welded onto Q33.
 */

function optionCount(q) {
  return Array.isArray(q?.options)
    ? q.options.filter((o) => String(o || '').trim()).length
    : 0;
}

function modalOptionCount(questions) {
  const counts = new Map();
  for (const q of questions || []) {
    const n = optionCount(q);
    if (n >= 2) counts.set(n, (counts.get(n) || 0) + 1);
  }
  let best = 5;
  let bestC = 0;
  for (const [n, c] of counts) {
    if (c > bestC || (c === bestC && n < best)) {
      best = n;
      bestC = c;
    }
  }
  return bestC > 0 ? best : 5;
}

/** True when stem looks like a cropped option/tail, not a real MCQ stem. */
function looksLikeOrphanFragment(stem) {
  const s = String(stem || '').trim();
  if (!s) return true;

  const hasQuestionCue =
    /[?]/.test(s) ||
    /^(which|what|when|where|who|whom|whose|how|why|calculate|find|determine|identify|state|define|explain|the coefficient|a condition|international|the drawer|the following)\b/i.test(
      s
    );

  // Mid-sentence crop: lowercase start, no interrogative, shortish
  if (/^[a-z]/.test(s) && !hasQuestionCue && s.length < 140) return true;

  // Classic dangling option / clause tails from previous question
  if (
    /^(between|among|and|or|of|to|for|from|with|without|than|into|onto|over|under|the rate|the price|the value|imports|exports)\b/i.test(
      s
    ) &&
    !hasQuestionCue &&
    s.length < 160
  ) {
    return true;
  }

  // Too short to be a stem and no cue
  if (s.length < 28 && !hasQuestionCue) return true;

  return false;
}

/**
 * Audit + repair a page's extracted questions.
 * Drops orphan-fragment mislabels; flags option-count / sequence anomalies.
 */
function auditExtractedQuestions(extracted, { pageNum = '?' } = {}) {
  const qs = Array.isArray(extracted?.questions) ? [...extracted.questions] : [];
  if (!qs.length) {
    return { questions: qs, flags: [], shouldEscalate: false, modal: 5, missing: [] };
  }

  const modal = modalOptionCount(qs);
  const kept = [];
  const flags = [];

  for (const q of qs) {
    const stem = String(q.question || '').trim();
    const opts = optionCount(q);
    const reasons = [];

    if (looksLikeOrphanFragment(stem) && !q.isContinuation) {
      reasons.push('orphan_leading_fragment');
    }
    // ANY deviation from the page's modal option count (4 vs 5 is as dangerous as 3 vs 5)
    if (
      modal >= 3 &&
      opts >= 1 &&
      opts !== modal &&
      !q.isContinuation &&
      !q.incomplete
    ) {
      reasons.push(`option_count_${opts}_vs_modal_${modal}`);
    }
    if (opts > 6) {
      reasons.push('excessive_options');
    }

    if (reasons.includes('orphan_leading_fragment')) {
      flags.push({
        questionNumber: q.questionNumber ?? null,
        action: 'drop',
        reasons,
        stemPreview: stem.slice(0, 80),
      });
      console.log(
        `[vision:coherence] Page ${pageNum}: DROPPED Q${q.questionNumber ?? '?'} (${reasons.join(', ')}) stem="${stem.slice(0, 70)}"`
      );
      continue;
    }

    if (reasons.length) {
      q.needsReview = true;
      q.confidence = Math.min(typeof q.confidence === 'number' ? q.confidence : 1, 0.35);
      q.coherenceFlags = reasons;
      flags.push({
        questionNumber: q.questionNumber ?? null,
        action: 'flag',
        reasons,
        stemPreview: stem.slice(0, 80),
      });
      console.log(
        `[vision:coherence] Page ${pageNum}: FLAGGED Q${q.questionNumber ?? '?'} (${reasons.join(', ')})`
      );
    }

    kept.push(q);
  }

  const numbered = kept
    .filter((q) => q.questionNumber != null && !Number.isNaN(Number(q.questionNumber)))
    .sort((a, b) => Number(a.questionNumber) - Number(b.questionNumber));

  for (let i = 1; i < numbered.length; i++) {
    const prev = Number(numbered[i - 1].questionNumber);
    const curr = Number(numbered[i].questionNumber);
    if (curr === prev) {
      numbered[i].needsReview = true;
      numbered[i].confidence = Math.min(numbered[i].confidence ?? 1, 0.4);
      flags.push({
        questionNumber: curr,
        action: 'flag',
        reasons: ['duplicate_number_on_page'],
      });
    } else if (curr < prev) {
      numbered[i].needsReview = true;
      numbered[i].confidence = Math.min(numbered[i].confidence ?? 1, 0.4);
      flags.push({
        questionNumber: curr,
        action: 'flag',
        reasons: ['non_monotonic_sequence'],
      });
    }
  }

  const missing = [];
  if (numbered.length >= 3) {
    const min = Number(numbered[0].questionNumber);
    const max = Number(numbered[numbered.length - 1].questionNumber);
    if (max - min <= 40) {
      const have = new Set(numbered.map((q) => Number(q.questionNumber)));
      for (let n = min; n <= max; n++) {
        if (!have.has(n)) missing.push(n);
      }
      if (missing.length > 0 && missing.length <= 4) {
        console.log(
          `[vision:coherence] Page ${pageNum}: missing Q# in sequence: ${missing.join(', ')}`
        );
        flags.push({
          questionNumber: null,
          action: 'gap',
          reasons: [`missing_${missing.join('_')}`],
        });
      }
    }
  }

  const shouldEscalate =
    flags.some((f) => f.action === 'drop' || f.action === 'gap') ||
    flags.some((f) => (f.reasons || []).some((r) => String(r).startsWith('option_count_'))) ||
    flags.filter((f) => f.action === 'flag').length >= 2;

  return { questions: kept, flags, shouldEscalate, modal, missing };
}

export {
  optionCount,
  modalOptionCount,
  looksLikeOrphanFragment,
  auditExtractedQuestions,
};
