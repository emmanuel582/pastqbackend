/**
 * Output contracts for every model call.
 *
 * Each validator returns a list of concrete, human-readable problems. Nothing
 * is defaulted, coerced or guessed: an invalid output goes back to the model
 * with the exact problems (repair turn) until it is valid or the attempt
 * budget is spent, at which point the caller surfaces a hard failure.
 */
import * as openrouterProvider from './openrouterProvider.js';
import { ProviderError } from './openrouterProvider.js';
import { schemaProblems } from './schemaCheck.js';

const REPAIR_ATTEMPTS = Number(process.env.VISION_REPAIR_ATTEMPTS || 3);
const ILLEGIBLE = '[ILLEGIBLE]';
const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice', 'true_false']);

/** Labels are bare identifiers so answer keys can match them ("1." and "(1)" are not). */
function labelProblem(label, where) {
  const l = String(label);
  if (l !== l.trim() || !l) return `${where}: label must not be empty or padded`;
  if (/^[\p{P}\p{S}]|[\p{P}\p{S}]$/u.test(l)) return `${where}: label "${l}" must be the bare identifier without punctuation (e.g. "1" not "1.", "iv" not "(iv)")`;
  return null;
}
const sameLetter = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function bboxProblems(bbox, where) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isInteger)) return [`${where}: bbox must be four integers [x0,y0,x1,y1]`];
  const [x0, y0, x1, y1] = bbox;
  if ([x0, y0, x1, y1].some((v) => v < 0 || v > 1000)) return [`${where}: bbox values must be within 0-1000`];
  if (x1 <= x0 || y1 <= y0) return [`${where}: bbox needs x1 > x0 and y1 > y0`];
  return [];
}

function questionText(q) {
  return [q.instruction, q.passage, q.stem, ...q.options.map((o) => o.text), ...q.parts.map((p) => p.text)].filter(Boolean).join('\n');
}

/** Problems in a page transcription. */
function validatePageResult(r, { sourceKind }) {
  const errors = [];
  const qs = r.questions || [];
  // Completeness: what was transcribed must match what the model saw.
  const norm = (l) => String(l).trim().toLowerCase();
  for (const [kind, items] of [['questions', qs], ['answers', r.answers], ['explanations', r.explanations]]) {
    const seen = new Set(r.inventory[kind].map(norm));
    const done = new Set(items.filter((x) => x.label != null).map((x) => norm(x.label)));
    const missing = [...seen].filter((l) => !done.has(l));
    const extra = [...done].filter((l) => !seen.has(l));
    if (missing.length) errors.push(`inventory lists ${kind} ${missing.slice(0, 40).join(', ')} but they were not transcribed — transcribe every one`);
    if (extra.length) errors.push(`${kind} ${extra.slice(0, 40).join(', ')} were transcribed but are missing from inventory.${kind}`);
  }
  if (r.pageType === 'blank' && (r.inventory.questions.length || r.inventory.answers.length || r.inventory.explanations.length)) {
    errors.push('pageType is "blank" but the inventory lists printed labels');
  }
  if (r.pageType === 'blank' && (qs.length || r.answers.length || r.explanations.length)) {
    errors.push('pageType is "blank" but questions/answers/explanations were returned');
  }
  if (sourceKind === 'text' && (r.pageIssues || []).some((i) => ['blurred', 'cropped', 'rotated', 'faint'].includes(i.issue))) {
    errors.push('pageIssues describe image problems, but this page is pasted text');
  }

  // Headings: refs h1..hn in order, each used once.
  const refs = r.headings.map((h) => h.ref);
  refs.forEach((ref, i) => { if (ref !== `h${i + 1}`) errors.push(`headings[${i}]: refs must be h1, h2, ... in reading order (got ${ref})`); });
  r.headings.forEach((h, i) => { if (!h.printedHeading.trim()) errors.push(`headings[${i}]: printedHeading is empty`); });
  if (r.runningHeader && r.headings.some((h) => h.printedHeading.trim() === r.runningHeader.trim())) {
    errors.push('a heading repeats the runningHeader; a running header is not a heading');
  }
  const validRefs = new Set(['carried', ...refs]);
  const refProblem = (ref, where) => (validRefs.has(ref) ? null : `${where}: headingRef "${ref}" is not one of this page's headings (${[...validRefs].join(', ')})`);
  // Items under a heading cannot come before items that are "carried".
  const order = (ref) => (ref === 'carried' ? 0 : refs.indexOf(ref) + 1);
  const checkOrder = (items, what) => items.forEach((x, i) => {
    if (i && order(x.headingRef) < order(items[i - 1].headingRef)) errors.push(`${what}[${i}]: headingRef ${x.headingRef} comes after an item under ${items[i - 1].headingRef}; items must follow reading order`);
  });
  checkOrder(qs, 'questions');
  checkOrder(r.answers, 'answers');
  checkOrder(r.explanations, 'explanations');

  const labelsByHeading = new Map();
  qs.forEach((q, i) => {
    const at = `questions[${i}]${q.label ? ` (label ${q.label})` : ''}`;
    const fragment = q.continuesFromPreviousPage || q.continuesOnNextPage;
    if (q.continuesFromPreviousPage && i !== 0) errors.push(`${at}: continuesFromPreviousPage is only possible for the first item on the page`);
    if (q.continuesOnNextPage && i !== qs.length - 1) errors.push(`${at}: continuesOnNextPage is only possible for the last item on the page`);
    if (!q.stem.trim() && !q.options.length && !q.parts.length) errors.push(`${at}: has no stem, options or parts`);
    if (!q.stem.trim() && !q.continuesFromPreviousPage) errors.push(`${at}: stem is empty but it is not a continuation`);

    if (q.label != null) { const p = labelProblem(q.label, at); if (p) errors.push(p); }
    { const p = refProblem(q.headingRef, at); if (p) errors.push(p); }
    const letters = q.options.map((o) => o.letter.trim());
    if (letters.some((l) => !l)) errors.push(`${at}: every option needs its printed letter/label`);
    if (new Set(letters.map((l) => l.toLowerCase())).size !== letters.length) errors.push(`${at}: option letters repeat (${letters.join(', ')})`);
    if (q.options.some((o) => !o.text.trim())) errors.push(`${at}: an option has empty text (use ${ILLEGIBLE} if it cannot be read)`);
    if (CHOICE_TYPES.has(q.type) && q.options.length < 2 && !fragment) errors.push(`${at}: type ${q.type} needs at least two options`);
    if (!CHOICE_TYPES.has(q.type) && q.type !== 'matching' && q.options.length) errors.push(`${at}: type ${q.type} should not have options — is the type right?`);

    if (q.answer) {
      if (!q.answer.letters.length && !q.answer.text) errors.push(`${at}: answer has neither letters nor text`);
      const unknown = q.answer.letters.filter((l) => !letters.some((x) => sameLetter(x, l)));
      if (unknown.length) errors.push(`${at}: answer letter(s) ${unknown.join(', ')} are not among the option letters ${letters.join(', ') || '(none)'}`);
      if (q.type === 'single_choice' && q.answer.letters.length > 1) errors.push(`${at}: single_choice question has more than one answer letter`);
    }
    if (!(q.confidence >= 0 && q.confidence <= 1)) errors.push(`${at}: confidence must be between 0 and 1`);

    const hasIllegible = questionText(q).includes(ILLEGIBLE);
    if (q.legibility === 'clear' && (hasIllegible || q.unclear.length)) errors.push(`${at}: legibility is "clear" but it has ${ILLEGIBLE} text or unclear regions`);
    if (q.legibility !== 'clear' && !hasIllegible && !q.unclear.length) errors.push(`${at}: legibility is "${q.legibility}" — mark the unreadable text with ${ILLEGIBLE} and list its regions in unclear`);

    if (sourceKind === 'text' && (q.figures.length || q.unclear.length)) errors.push(`${at}: pasted text has no image, so figures/unclear regions cannot be given`);
    q.figures.forEach((f, j) => {
      errors.push(...bboxProblems(f.bbox, `${at} figures[${j}]`));
      if (!f.description.trim()) errors.push(`${at} figures[${j}]: description is required`);
    });
    q.unclear.forEach((u, j) => errors.push(...bboxProblems(u.bbox, `${at} unclear[${j}]`)));

    if (q.label) {
      const key = `${q.headingRef}::${q.label}`;
      if (labelsByHeading.has(key)) errors.push(`${at}: label ${q.label} appears twice under ${q.headingRef} on this page`);
      labelsByHeading.set(key, true);
    }
  });

  r.answers.forEach((a, i) => {
    { const p = labelProblem(a.label, `answers[${i}]`); if (p) errors.push(p); }
    { const p = refProblem(a.headingRef, `answers[${i}]`); if (p) errors.push(p); }
    if (!a.letters.length && !a.text) errors.push(`answers[${i}]: needs letters or text`);
  });
  r.explanations.forEach((e, i) => {
    { const p = labelProblem(e.label, `explanations[${i}]`); if (p) errors.push(p); }
    { const p = refProblem(e.headingRef, `explanations[${i}]`); if (p) errors.push(p); }
    if (!e.text.trim()) errors.push(`explanations[${i}]: text is empty`);
    // "6E" is usually question 6 with answer E; the model must say which it is.
    if (/^\d+[a-z]$/i.test(e.label) && !e.labelHasPartLetter) {
      errors.push(`explanations[${i}]: label "${e.label}" looks like question ${e.label.slice(0, -1)} with answer ${e.label.slice(-1).toUpperCase()} — use label "${e.label.slice(0, -1)}" with answerLetters ["${e.label.slice(-1).toUpperCase()}"], or set labelHasPartLetter=true if it is a sub-part`);
    }
    if (e.labelHasPartLetter && e.answerLetters.length === 0 && !/[a-z]$/i.test(e.label)) errors.push(`explanations[${i}]: labelHasPartLetter is true but the label has no part letter`);
  });
  return errors;
}

/**
 * Problems in one structure window.
 * nodeIds: this window's heading nodes in document order.
 * earlierQuestionIds: question-section ids from earlier windows.
 */
function validateStructure(r, { nodeIds, earlierQuestionIds, hasOpen }) {
  const errors = [];
  const secs = r.sections;
  if (!secs.length) return ['sections is empty; every node must belong to a section'];
  const keys = secs.map((x) => x.localKey.trim());
  if (keys.some((k) => !k)) errors.push('every section needs a localKey');
  if (new Set(keys).size !== keys.length) errors.push(`localKeys repeat: ${keys.join(', ')}`);

  const flat = secs.flatMap((x) => x.nodes);
  if (flat.length !== nodeIds.length || flat.some((n, i) => n !== nodeIds[i])) {
    const missing = nodeIds.filter((n) => !flat.includes(n));
    const dup = flat.filter((n, i) => flat.indexOf(n) !== i);
    errors.push(`sections must list every node exactly once, in document order${missing.length ? `; missing: ${missing.slice(0, 20).join(', ')}` : ''}${dup.length ? `; repeated: ${[...new Set(dup)].slice(0, 20).join(', ')}` : ''}`);
  }
  const questionKeys = new Set(secs.filter((x) => x.kind === 'questions').map((x) => x.localKey));
  const earlier = new Set(earlierQuestionIds);
  secs.forEach((x, i) => {
    const at = `sections[${i}] "${x.title}"`;
    if (!x.nodes.length) errors.push(`${at}: has no nodes`);
    if (!x.title.trim()) errors.push(`sections[${i}]: title is empty`);
    if (x.continuesPrevious && (i > 0 || !hasOpen)) errors.push(`${at}: only the first section can continue the open section from the previous window`);
    const isAnswers = x.kind === 'answer_key' || x.kind === 'explanations';
    if (!isAnswers && x.answersFor.length) errors.push(`${at}: only answer_key/explanations sections have answersFor`);
    for (const ref of x.answersFor) {
      if (!questionKeys.has(ref) && !earlier.has(ref)) errors.push(`${at}: answersFor "${ref}" is not a question section localKey here or an earlier question section id`);
    }
    if (isAnswers && !x.answersFor.length && !x.unlinkedReason?.trim()) {
      errors.push(`${at}: link it to the question section(s) it answers in answersFor, or say why it cannot be linked in unlinkedReason`);
    }
    if (x.answersFor.length && x.unlinkedReason) errors.push(`${at}: unlinkedReason is only for sections with no answersFor`);
  });
  return errors;
}

function validateAdjudication(r, { conflicts }) {
  const errors = [];
  const byId = new Map(conflicts.map((c) => [c.id, c]));
  const seen = new Set();
  for (const d of r.decisions) {
    const c = byId.get(d.conflictId);
    if (seen.has(d.conflictId)) errors.push(`conflict ${d.conflictId} decided twice`);
    seen.add(d.conflictId);
    const items = new Set(c.items.map((x) => x.itemId));
    if (d.drop.some((id) => !items.has(id))) errors.push(`conflict ${d.conflictId}: drop lists items that are not part of it`);
    if (c.type === 'duplicate_label' && d.drop.length >= items.size) errors.push(`conflict ${d.conflictId}: cannot drop every item`);
    if (c.type === 'continuation' && d.drop.length) errors.push(`conflict ${d.conflictId}: continuation conflicts use merge, not drop`);
    if (!d.reason.trim()) errors.push(`conflict ${d.conflictId}: reason is required`);
  }
  for (const c of conflicts) if (!seen.has(c.id)) errors.push(`conflict ${c.id} was not decided`);
  return errors;
}

function validateLibrary(r, { subjectLabels }) {
  const errors = [];
  if (!r.catalogGroup.trim()) errors.push('catalogGroup is empty');
  const mapped = r.canonicalSubjects.map((s) => s.label);
  for (const l of subjectLabels) if (!mapped.includes(l)) errors.push(`subject label "${l}" was not mapped`);
  if (r.canonicalSubjects.some((s) => !s.canonical.trim())) errors.push('a canonical subject is empty');
  return errors;
}

/**
 * Call the model with a strict schema, validate, and run repair turns until
 * the output satisfies the contract. Throws ProviderError('invalid_output')
 * listing the remaining problems when the budget is spent.
 */
async function askValidated({ messages, schema, schemaName, validate, model, maxTokens }) {
  const convo = [...messages];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let errors = [];
  for (let attempt = 0; attempt <= REPAIR_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await openrouterProvider.visionJson({ messages: convo, schema, schemaName, model: model.id, maxTokens: maxTokens || model.maxOutputTokens });
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'invalid_output') throw err;
      errors = [err.message];
      convo.push({ role: 'user', content: `Your previous reply could not be parsed: ${err.message}. Reply again with JSON only.` });
      continue;
    }
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    // Shape first, so contract checks never see a malformed object.
    errors = schemaProblems(schema, res.data);
    if (!errors.length) errors = validate(res.data);
    if (!errors.length) return { data: res.data, usage, attempts: attempt + 1 };
    convo.push({ role: 'assistant', content: res.raw });
    convo.push({ role: 'user', content: `That output breaks these rules:\n- ${errors.join('\n- ')}\nReturn the complete corrected JSON.` });
  }
  const err = new ProviderError('invalid_output', `${schemaName} still invalid after ${REPAIR_ATTEMPTS} repair attempts: ${errors.join('; ')}`);
  err.usage = usage;
  throw err;
}

export {
  ILLEGIBLE,
  validatePageResult,
  validateStructure,
  validateAdjudication,
  validateLibrary,
  askValidated,
  bboxProblems,
};
