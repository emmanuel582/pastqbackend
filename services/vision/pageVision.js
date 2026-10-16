/**
 * Stage 2 — agentic page transcription.
 *
 * One tool-calling conversation per page, the way a coding agent works on a
 * file: look at the page, zoom into anything small, faint or blurred, check
 * the neighbouring page for split questions, submit, get validated, fix,
 * then confirm the crops of every figure box before the page is accepted.
 */
import fs from 'fs';
import * as openrouterProvider from './openrouterProvider.js';
import { PAGE_PROMPT, pageTools, pageResultSchema } from './visionPrompts.js';
import { schemaProblems } from './schemaCheck.js';
import { validatePageResult, bboxProblems } from './contract.js';
import { cropRegion } from './figures.js';

// Request size matters at scale: the page is sent at a size the model reads
// well, and fine detail comes from zoom crops of the full-resolution original.
const PAGE_IMAGE_SIDE = Number(process.env.VISION_PAGE_IMAGE_SIDE || 1600);
const ZOOM_SIDE = Number(process.env.VISION_ZOOM_SIDE || 1200);
const IMAGE_QUALITY = Number(process.env.VISION_IMAGE_QUALITY || 90);
// Dense mixed pages (answers + tables + new topic + figures) legitimately need
// more look/zoom/repair turns; simple pages finish in 2-4.
const PAGE_TURNS = Number(process.env.VISION_PAGE_TURNS || 24);

async function pageImageDataUrl(page) {
  return openrouterProvider.toDataUrl(fs.readFileSync(page.imagePath), { maxSide: PAGE_IMAGE_SIDE, quality: IMAGE_QUALITY });
}

async function pagePart(page) {
  if (page.textPath) return { type: 'text', text: `Page ${page.index + 1} text:\n${fs.readFileSync(page.textPath, 'utf8')}` };
  return { type: 'image_url', image_url: { url: await pageImageDataUrl(page) } };
}

/** Map a validated model result to the stored question shape. Pure. */
function toStoredResult(result, pageNumber) {
  return {
    pageNumber,
    pageType: result.pageType,
    legibility: result.legibility,
    pageIssues: result.pageIssues,
    runningHeader: result.runningHeader,
    headings: result.headings,
    questions: result.questions.map((q) => {
      const letters = q.options.map((o) => o.letter.trim());
      const answerLetters = q.answer?.letters || [];
      const reviewReasons = [
        q.legibility !== 'clear' ? `legibility_${q.legibility}` : null,
        ...q.unclear.map((u) => `unclear: ${u.note}`),
      ].filter(Boolean);
      return {
        label: q.label,
        headingRef: q.headingRef,
        type: q.type,
        instruction: q.instruction,
        passage: q.passage,
        question: q.stem,
        options: q.options.map((o) => o.text),
        optionLetters: letters,
        parts: q.parts,
        marks: q.marks,
        correct: answerLetters.length === 1 ? letters.findIndex((l) => l.toLowerCase() === answerLetters[0].trim().toLowerCase()) : null,
        correctLetters: answerLetters,
        answerText: q.answer?.text || null,
        year: q.year,
        sourceRef: q.sourceRef,
        topic: q.topic,
        subject: q.subject,
        figures: q.figures,
        legibility: q.legibility,
        unclear: q.unclear,
        continuesFromPreviousPage: q.continuesFromPreviousPage,
        continuesOnNextPage: q.continuesOnNextPage,
        confidence: q.confidence,
        reviewReasons,
        needsReview: reviewReasons.length > 0,
      };
    }),
    answers: result.answers.map((a) => ({ headingRef: a.headingRef, label: a.label, letters: a.letters, text: a.text })),
    explanations: result.explanations.map((e) => ({ headingRef: e.headingRef, label: e.label, text: e.text, answerLetters: e.answerLetters || [] })),
  };
}

/**
 * Transcribe one page. Throws ProviderError when the page cannot be brought
 * to a valid, figure-confirmed result within the turn budget.
 */
async function transcribePage({ page, neighbours, model, note = null }) {
  const pageNumber = Number(page.index) + 1;
  const sourceKind = page.textPath ? 'text' : 'image';
  const tools = pageTools({ hasImage: sourceKind === 'image' });
  const inspections = [];
  let shownFigureKey = null;

  const handlers = {
    async zoom({ bbox }) {
      const problems = bboxProblems(bbox, 'zoom');
      if (problems.length) return problems.join('; ');
      const crop = await cropRegion(page.imagePath, bbox);
      inspections.push({ tool: 'zoom', bbox });
      return { text: `Zoomed region ${JSON.stringify(bbox)} attached.`, imageDataUrl: await openrouterProvider.toDataUrl(crop.buffer, { maxSide: ZOOM_SIDE, quality: IMAGE_QUALITY }) };
    },
    async view_page({ offset }) {
      const target = offset < 0 ? neighbours.prev : neighbours.next;
      inspections.push({ tool: 'view_page', offset });
      if (!target) return offset < 0 ? 'This is the first page of the upload.' : 'This is the last page uploaded so far.';
      const part = await pagePart(target);
      if (part.type === 'text') return part.text;
      return { text: `Page ${target.index + 1} attached.`, imageDataUrl: part.image_url.url };
    },
  };

  const onSubmit = async ({ result }) => {
    // Shape first: providers do not always enforce strict tool schemas.
    const shape = schemaProblems(pageResultSchema(), result);
    if (shape.length) return { ok: false, errors: shape };
    const errors = validatePageResult(result, { sourceKind });
    if (errors.length) return { ok: false, errors };
    const boxes = result.questions.flatMap((q) => q.figures.map((f) => f.bbox));
    if (!boxes.length) return { ok: true, value: result };
    const key = JSON.stringify(boxes);
    if (result.figuresConfirmed && key === shownFigureKey) return { ok: true, value: result };
    shownFigureKey = key;
    const images = [];
    for (const bbox of boxes) {
      const crop = await cropRegion(page.imagePath, bbox);
      images.push(await openrouterProvider.toDataUrl(crop.buffer, { maxSide: ZOOM_SIDE, quality: IMAGE_QUALITY }));
    }
    return {
      ok: false,
      images,
      message: `Crops of your ${boxes.length} figure box(es) are attached in order. If every crop contains its whole figure (all labels and caption, nothing important cut), call submit again unchanged with figuresConfirmed=true. Otherwise correct the boxes and submit.`,
    };
  };

  const { value, usage, turns } = await openrouterProvider.chatWithTools({
    messages: [
      { role: 'system', content: PAGE_PROMPT },
      { role: 'user', content: [{ type: 'text', text: `Page ${pageNumber} (${sourceKind === 'text' ? 'pasted text, no image' : 'page image attached'}).${note ? `
${note}` : ''}` }, await pagePart(page)] },
    ],
    tools,
    handlers,
    stopTool: 'submit',
    onSubmit,
    model: model.id,
    maxTurns: PAGE_TURNS,
    maxTokens: model.maxOutputTokens,
  });
  return { result: toStoredResult(value, pageNumber), usage, turns, inspections };
}

export { transcribePage, toStoredResult, pageImageDataUrl };
