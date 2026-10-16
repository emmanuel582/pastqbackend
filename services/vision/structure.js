/**
 * Document structure from per-page headings.
 *
 * Each page transcription reports the headings that start something on that
 * page, and every question/answer/explanation points at one of them (or is
 * "carried" from the previous page). That gives an ordered list of heading
 * nodes for the whole document. The model then groups the nodes into the
 * document's real sections and links answer keys — a text-only call over a
 * compact summary, run in fixed-size windows so any document length works.
 */
import { STRUCTURE_PROMPT, structureSchema } from './visionPrompts.js';
import { askValidated, validateStructure } from './contract.js';

const WINDOW = Number(process.env.VISION_STRUCTURE_WINDOW || 200);
const START_NODE = 'start';

/**
 * Walk pages in order and give every item the heading node it belongs to.
 * Returns { nodes, nodeOf(pageId, headingRef) }.
 */
function buildNodes(pages, results) {
  const nodes = [];
  const byKey = new Map();
  let open = null;
  const ensureStart = (page) => {
    if (!byKey.has(START_NODE)) {
      const n = { id: START_NODE, page: page.index + 1, printedHeading: '(content before the first heading)', kind: null, year: null, topic: null, subject: null, paperLabel: null, runningHeader: null, items: { questions: [], answers: [], explanations: [], years: new Set() } };
      nodes.unshift(n);
      byKey.set(START_NODE, n);
    }
    return START_NODE;
  };
  const ordered = [...pages].sort((a, b) => a.index - b.index);
  const pageNode = new Map(); // `${pageId}:${ref}` → node id
  for (const page of ordered) {
    const res = results.get(page.id);
    if (!res) continue;
    const carriedNode = () => open || ensureStart(page);
    pageNode.set(`${page.id}:carried`, null); // resolved lazily below
    let carriedId = null;
    const hasCarried = [...res.questions, ...res.answers, ...res.explanations].some((x) => x.headingRef === 'carried');
    if (hasCarried) carriedId = carriedNode();
    pageNode.set(`${page.id}:carried`, carriedId);
    for (const h of res.headings) {
      const id = `${page.id}:${h.ref}`;
      const n = { id, page: page.index + 1, printedHeading: h.printedHeading, kind: h.kind, year: h.year, topic: h.topic, subject: h.subject, paperLabel: h.paperLabel, runningHeader: res.runningHeader, items: { questions: [], answers: [], explanations: [], years: new Set() } };
      nodes.push(n);
      byKey.set(id, n);
      pageNode.set(id, id);
      open = id;
    }
    for (const [list, key] of [[res.questions, 'questions'], [res.answers, 'answers'], [res.explanations, 'explanations']]) {
      for (const x of list) {
        const n = byKey.get(pageNode.get(`${page.id}:${x.headingRef}`));
        if (x.label) n.items[key].push(x.label);
        if (key === 'questions' && x.year) n.items.years.add(x.year);
      }
    }
  }
  return { nodes, nodeOf: (pageId, ref) => pageNode.get(`${pageId}:${ref}`) };
}

function summarise(n) {
  const range = (labels) => (labels.length ? { count: labels.length, first: labels[0], last: labels.at(-1) } : null);
  return {
    node: n.id,
    page: n.page,
    printedHeading: n.printedHeading,
    kind: n.kind,
    year: n.year,
    topic: n.topic,
    subject: n.subject,
    paperLabel: n.paperLabel,
    runningHeader: n.runningHeader,
    questions: range(n.items.questions),
    questionYears: [...n.items.years].sort(),
    answers: range(n.items.answers),
    explanations: range(n.items.explanations),
  };
}

/**
 * Run the structure model over all nodes and return the outline:
 * { organizedBy, documentTitle, sections[], nodeToSection }.
 */
async function buildStructure(nodes, model) {
  const outline = { version: 4, organizedBy: null, documentTitle: null, sections: [], nodeToSection: {} };
  const votes = {};
  const usage = { promptTokens: 0, completionTokens: 0 };
  for (let i = 0; i < nodes.length; i += WINDOW) {
    const windowNodes = nodes.slice(i, i + WINDOW);
    const nodeIds = windowNodes.map((n) => n.id);
    const open = outline.sections.at(-1) || null;
    const earlier = outline.sections.filter((s) => s.kind === 'questions');
    const { data, usage: u } = await askValidated({
      messages: [
        { role: 'system', content: STRUCTURE_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            open: open ? { id: open.id, title: open.title, kind: open.kind, year: open.year, topic: open.topic } : null,
            earlier: earlier.slice(-200).map((s) => ({ id: s.id, title: s.title, year: s.year, topic: s.topic })),
            nodes: windowNodes.map(summarise),
          }),
        },
      ],
      schema: structureSchema({ nodeIds, earlierIds: earlier.map((s) => s.id), hasOpen: Boolean(open) }),
      schemaName: 'document_structure',
      validate: (r) => validateStructure(r, { nodeIds, earlierQuestionIds: earlier.map((s) => s.id), hasOpen: Boolean(open) }),
      model,
    });
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    votes[data.organizedBy] = (votes[data.organizedBy] || 0) + windowNodes.length;
    if (!outline.documentTitle && data.documentTitle) outline.documentTitle = data.documentTitle;

    const idForKey = new Map();
    for (const s of data.sections) {
      if (s.continuesPrevious) {
        open.nodes.push(...s.nodes);
        idForKey.set(s.localKey, open.id);
        open.pendingAnswersFor = s.answersFor;
        continue;
      }
      const id = `s${outline.sections.length + 1}`;
      idForKey.set(s.localKey, id);
      outline.sections.push({
        id, title: s.title.trim(), kind: s.kind, year: s.year, topic: s.topic, subject: s.subject, paperLabel: s.paperLabel,
        nodes: [...s.nodes], answersFor: [], unlinkedReason: s.unlinkedReason, pendingAnswersFor: s.answersFor,
      });
    }
    for (const s of outline.sections) {
      if (!s.pendingAnswersFor) continue;
      s.answersFor = [...new Set([...s.answersFor, ...s.pendingAnswersFor.map((ref) => idForKey.get(ref) || ref)])];
      delete s.pendingAnswersFor;
    }
  }
  outline.organizedBy = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const pageOf = new Map(nodes.map((n) => [n.id, n.page]));
  for (const s of outline.sections) {
    for (const n of s.nodes) outline.nodeToSection[n] = s.id;
    const ps = s.nodes.map((n) => pageOf.get(n));
    s.pageStart = Math.min(...ps);
    s.pageEnd = Math.max(...ps);
    s.printedHeadings = s.nodes.map((n) => nodes.find((x) => x.id === n)?.printedHeading).filter(Boolean);
  }
  return { outline, usage };
}

/** Copy of the page results with sectionId set on every item. */
function applySections(pages, results, outline) {
  const { nodeOf } = buildNodes(pages, results);
  const out = new Map();
  for (const [pageId, res] of results) {
    const tag = (x) => ({ ...x, sectionId: outline.nodeToSection[nodeOf(pageId, x.headingRef)] });
    out.set(pageId, { ...res, questions: res.questions.map(tag), answers: res.answers.map(tag), explanations: res.explanations.map(tag) });
  }
  return out;
}

export { buildNodes, buildStructure, applySections, summarise, START_NODE };
