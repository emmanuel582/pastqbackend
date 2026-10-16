/**
 * Deterministic assembly of per-page results into the session.
 *
 * A pure function of (pages, outline, page results, adjudications), so pages
 * can be transcribed in parallel, in any order, retried or resumed, and the
 * output is always the same. It never guesses: where page results disagree
 * (a continuation one page claims and the other denies, one label captured
 * twice) it emits a conflict for the model to adjudicate (adjudicate.js);
 * until decided, every item is kept and flagged.
 *
 * Grouping follows the document's own outline sections.
 */

const LEGIBILITY_RANK = { clear: 0, partial: 1, illegible: 2 };

// Option letters are identifiers; their printed case can differ between a
// question ("(b)") and its answer key ("B").
const sameLetter = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const sameLetters = (a, b) => a.length === b.length && a.every((x, i) => sameLetter(x, b[i]));
const letterIndex = (optionLetters, answerLetters) => (answerLetters.length === 1 ? optionLetters.findIndex((l) => sameLetter(l, answerLetters[0])) : null);

function addReason(q, reason) {
  q.reviewReasons = [...new Set([...(q.reviewReasons || []), reason])];
  q.needsReview = true;
}

function mergeInto(target, frag, pageIndex) {
  if (frag.question) target.question = [target.question, frag.question].filter(Boolean).join('\n');
  target.options.push(...frag.options);
  target.optionLetters.push(...frag.optionLetters);
  target.parts.push(...frag.parts);
  target.figures.push(...frag.figures);
  target.unclear.push(...frag.unclear);
  if (!target.correctLetters.length && frag.correctLetters.length) {
    target.correctLetters = frag.correctLetters;
    target.answerText = frag.answerText;
  }
  target.correct = letterIndex(target.optionLetters, target.correctLetters);
  if (LEGIBILITY_RANK[frag.legibility] > LEGIBILITY_RANK[target.legibility]) target.legibility = frag.legibility;
  target.confidence = Math.min(target.confidence, frag.confidence);
  target.continuesOnNextPage = frag.continuesOnNextPage;
  target.continuesToPage = pageIndex;
  target.reviewReasons = [...new Set([...target.reviewReasons, ...frag.reviewReasons])];
  target.needsReview = target.reviewReasons.length > 0;
}

/**
 * @param session   { id, pages, outline, questionIdByKey, adjudications, subjectHint }
 * @param results   Map(pageId → stored page result)
 */
function assembleSession(session, results) {
  const outline = session.outline;
  const sectionById = new Map(outline.sections.map((s) => [s.id, s]));
  const decisions = session.adjudications || {};
  const idByKey = { ...(session.questionIdByKey || {}) };
  let nextId = Object.values(idByKey).reduce((m, v) => Math.max(m, v), 0) + 1;
  const followUps = [];
  const conflicts = [];
  const pages = [...session.pages].sort((a, b) => a.index - b.index);
  const pageByIndex = new Map(pages.map((p) => [p.index, p]));

  // 1. Items in document order, with stable keys.
  const items = [];
  for (const page of pages) {
    const res = results.get(page.id);
    if (!res) continue;
    res.questions.forEach((raw, i) => {
      items.push({ key: `${page.id}:${i}`, page, raw, pos: i, last: i === res.questions.length - 1 });
    });
  }
  const itemByKey = new Map(items.map((it) => [it.key, it]));

  const toQuestion = (it) => {
    if (!idByKey[it.key]) idByKey[it.key] = nextId++;
    const section = sectionById.get(it.raw.sectionId);
    return {
      ...structuredClone(it.raw),
      id: idByKey[it.key],
      key: it.key,
      section: section.title,
      questionNumber: it.raw.label,
      year: it.raw.year || section.year || session.manualDefaults?.year || null,
      topic: it.raw.topic || section.topic || (outline.organizedBy === 'topic' ? section.title : null),
      subject: it.raw.subject || section.subject || session.subjectHint || null,
      // `paper` kept for clients that still read it.
      paper: section.paperLabel || section.title,
      pageIndex: it.page.index,
      continuesToPage: null,
      answerSource: it.raw.correctLetters.length ? 'inline' : null,
      explanation: '',
      sourceType: 'question',
    };
  };

  // 2. Continuations across pages.
  const questions = [];
  let prevItemQuestion = null; // question built from the last item of the previous processed page
  let prevItem = null;
  for (const it of items) {
    const prevPage = pageByIndex.get(it.page.index - 1);
    if (it.pos === 0 && it.raw.continuesFromPreviousPage) {
      const adjacentPrev = prevItem && prevItem.page.index === it.page.index - 1 && prevItem.last ? prevItem : null;
      if (!adjacentPrev) {
        if (!prevPage) {
          followUps.push({ id: `orphan-${it.page.id}`, type: 'missing_page', pageId: it.page.id, message: `Page ${it.page.index + 1} starts mid-question, but the page before it was not uploaded. Upload page ${it.page.index} to complete that question.` });
          const q = toQuestion(it);
          addReason(q, 'continuation_source_missing');
          questions.push(q);
          prevItem = it; prevItemQuestion = q;
          continue;
        }
        if (!results.has(prevPage.id) && prevPage.status !== 'failed') {
          // Previous page not transcribed yet: the next assembly will stitch it.
          prevItem = null; prevItemQuestion = null;
          continue;
        }
        // Previous page failed, or has no question to continue.
        const q = toQuestion(it);
        addReason(q, results.has(prevPage.id) ? 'continuation_source_not_found' : 'continuation_source_page_failed');
        questions.push(q);
        prevItem = it; prevItemQuestion = q;
        continue;
      }
      if (adjacentPrev) {
        const agreed = adjacentPrev.raw.continuesOnNextPage;
        const conflictId = `cont-${it.page.id}`;
        const decision = decisions[conflictId];
        if (agreed || decision?.merge === true) {
          mergeInto(prevItemQuestion, structuredClone(it.raw), it.page.index);
          prevItem = it;
          continue;
        }
        if (!decision) {
          conflicts.push({ id: conflictId, type: 'continuation', items: [
            { itemId: adjacentPrev.key, page: adjacentPrev.page.index + 1, text: prevItemQuestion.question, options: prevItemQuestion.options },
            { itemId: it.key, page: it.page.index + 1, text: it.raw.question, options: it.raw.options },
          ] });
        }
        const q = toQuestion(it);
        if (!decision) addReason(q, 'continuation_unresolved');
        questions.push(q);
        prevItem = it; prevItemQuestion = q;
        continue;
      }
    }
    const q = toQuestion(it);
    questions.push(q);
    prevItem = it; prevItemQuestion = q;
  }

  // A question that runs off a page whose next page is transcribed but does not continue it.
  for (const q of questions) {
    if (!q.continuesOnNextPage) continue;
    const endPage = q.continuesToPage ?? q.pageIndex;
    const next = pageByIndex.get(endPage + 1);
    if (!next) {
      followUps.push({ id: `runoff-${q.key}`, type: 'missing_page', message: `Question ${q.questionNumber ?? '(unnumbered)'} on page ${endPage + 1} continues onto a page that was not uploaded.` });
      addReason(q, 'continuation_target_missing');
      continue;
    }
    const nextRes = results.get(next.id);
    if (!nextRes) continue;
    if (!nextRes.questions[0]?.continuesFromPreviousPage) {
      const conflictId = `cont-${next.id}`;
      const decision = decisions[conflictId];
      const first = nextRes.questions[0] ? itemByKey.get(`${next.id}:0`) : null;
      if (first && !decision) {
        conflicts.push({ id: conflictId, type: 'continuation', items: [
          { itemId: q.key, page: endPage + 1, text: q.question, options: q.options },
          { itemId: first.key, page: next.index + 1, text: first.raw.question, options: first.raw.options },
        ] });
        addReason(q, 'continuation_unresolved');
      } else if (first && decision?.merge) {
        const idx = questions.findIndex((x) => x.key === first.key);
        if (idx >= 0) {
          mergeInto(q, structuredClone(first.raw), next.index);
          questions.splice(idx, 1);
        }
      } else if (!first) {
        addReason(q, 'continuation_target_missing');
      }
    }
  }

  // 3. One printed label captured more than once in a section.
  const bySlot = new Map();
  for (const q of questions) {
    if (!q.questionNumber) continue;
    const slot = `${q.sectionId}::${q.questionNumber}`;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(q);
  }
  const dropped = new Set();
  for (const [slot, dups] of bySlot) {
    if (dups.length < 2) continue;
    const conflictId = `dup-${slot}`;
    const decision = decisions[conflictId];
    if (decision) {
      for (const k of decision.drop) dropped.add(k);
      continue;
    }
    conflicts.push({ id: conflictId, type: 'duplicate_label', items: dups.map((q) => ({ itemId: q.key, page: q.pageIndex + 1, label: q.questionNumber, text: q.question, options: q.options, legibility: q.legibility })) });
    dups.forEach((q) => addReason(q, 'duplicate_label_unresolved'));
  }
  const kept = questions.filter((q) => !dropped.has(q.key));

  // 4. Answer keys and explanations, matched by (question section, printed label).
  const slotIndex = new Map();
  for (const q of kept) {
    if (!q.questionNumber) continue;
    const k = `${q.sectionId}::${q.questionNumber}`;
    if (!slotIndex.has(k)) slotIndex.set(k, []);
    slotIndex.get(k).push(q);
  }
  const targetsFor = (sectionId) => {
    const s = sectionById.get(sectionId);
    return s.kind === 'questions' ? [s.id] : s.answersFor;
  };
  const answerKeys = [];
  const unmatched = new Map();
  for (const page of pages) {
    const res = results.get(page.id);
    if (!res) continue;
    // Answers come from answer-key entries, and from explanations that print
    // the answer letter with them ("6E. ..."); an explicit key entry wins.
    const keyed = new Set(res.answers.map((x) => `${x.sectionId}::${x.label}`));
    const fromExplanations = res.explanations
      .filter((e) => e.answerLetters?.length && !keyed.has(`${e.sectionId}::${e.label}`))
      .map((e) => ({ sectionId: e.sectionId, headingRef: e.headingRef, label: e.label, letters: e.answerLetters, text: null }));
    for (const a of [...res.answers, ...fromExplanations]) {
      const targets = targetsFor(a.sectionId);
      answerKeys.push({ ...a, pageIndex: page.index, targetSectionIds: targets });
      if (!targets.length) continue; // reported once per section below
      const hits = targets.flatMap((t) => slotIndex.get(`${t}::${a.label}`) || []);
      if (hits.length !== 1) {
        if (!unmatched.has(a.sectionId)) unmatched.set(a.sectionId, { none: [], many: [] });
        unmatched.get(a.sectionId)[hits.length ? 'many' : 'none'].push(a.label);
        continue;
      }
      const q = hits[0];
      if (q.correctLetters.length && !sameLetters(q.correctLetters, a.letters)) {
        addReason(q, `answer_conflict: page shows ${q.correctLetters.join(',')}, key shows ${a.letters.join(',') || a.text}`);
        continue;
      }
      const missing = a.letters.filter((l) => !q.optionLetters.some((x) => sameLetter(x, l)));
      if (missing.length) {
        addReason(q, `answer_key_letter_not_an_option: ${missing.join(',')}`);
        continue;
      }
      q.correctLetters = a.letters;
      q.answerText = a.text;
      q.correct = letterIndex(q.optionLetters, a.letters);
      q.answerSource = 'answer_key';
    }
    for (const e of res.explanations) {
      const hits = targetsFor(e.sectionId).flatMap((t) => slotIndex.get(`${t}::${e.label}`) || []);
      if (hits.length === 1) hits[0].explanation = [hits[0].explanation, e.text].filter(Boolean).join('\n');
    }
  }
  for (const s of outline.sections) {
    if ((s.kind === 'answer_key' || s.kind === 'explanations') && !s.answersFor.length && s.answersForNote) {
      followUps.push({ id: `unlinked-${s.id}`, type: 'answers_unlinked', message: `"${s.title}" (pages ${s.pageStart}-${s.pageEnd}) answers questions that are not in this upload: ${s.answersForNote}` });
    }
  }
  for (const [sectionId, u] of unmatched) {
    const s = sectionById.get(sectionId);
    if (u.none.length) followUps.push({ id: `nomatch-${sectionId}`, type: 'answers_unmatched', message: `"${s.title}" lists answers for ${u.none.join(', ')}, but no question with those numbers was found in the linked section(s).` });
    if (u.many.length) followUps.push({ id: `ambiguous-${sectionId}`, type: 'answers_ambiguous', message: `"${s.title}" answers ${u.many.join(', ')} match more than one question.` });
  }

  kept.forEach((q, i) => { q.orderIndex = i + 1; });

  // 5. Groups in outline order.
  const groups = [];
  for (const s of outline.sections) {
    const qs = kept.filter((q) => q.sectionId === s.id);
    if (!qs.length) continue;
    const years = [...new Set(qs.map((q) => q.year).filter(Boolean))].sort();
    groups.push({
      id: s.id, sectionId: s.id, title: s.title, kind: s.kind, topic: s.topic, subject: s.subject,
      year: s.year || (years.length === 1 ? years[0] : null), years,
      paper: s.paperLabel || s.title,
      questionIds: qs.map((q) => q.id), count: qs.length,
    });
  }

  return { questions: kept, groups, answerKeys, followUps, conflicts, questionIdByKey: idByKey };
}

export { assembleSession, mergeInto };
