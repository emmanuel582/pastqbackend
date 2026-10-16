/**
 * Prompts and JSON schemas for the vision pipeline.
 *
 * Every model call has bounded size: one page image per transcription call,
 * and compact text for structure/adjudication/library calls. References the
 * model can make are enums wherever the valid set is known up front, and are
 * otherwise checked by the contracts (contract.js). Nothing here names an
 * exam board, institution, country or subject.
 */

const enumOf = (values) => ({ type: 'string', enum: values });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const BBOX = { type: 'array', items: { type: 'integer' }, description: '[x0, y0, x1, y1] on this image, 0-1000 normalised, top-left origin' };

const PAGE_ISSUES = ['blurred', 'cropped', 'rotated', 'faint', 'handwriting', 'adjacent_page_bleed', 'duplicate_page', 'missing_page_before', 'blank', 'other'];
const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'true_false', 'fill_in_blank', 'short_answer', 'essay', 'matching', 'structured', 'calculation', 'other'];
const FIGURE_KINDS = ['diagram', 'graph', 'chart', 'table', 'map', 'chemical_structure', 'circuit', 'photo', 'other'];
const SECTION_KINDS = ['questions', 'answer_key', 'explanations', 'front_matter'];
const HEADING_REFS = Array.from({ length: 16 }, (_, i) => `h${i + 1}`);
const NEUTRAL_TITLE_RULE = 'built only from subject, topic, year and paper/section words (e.g. "2011 Biology", "Organic Chemistry", "Paper 2 Section B"); never an institution, university, exam board, examination programme, publisher, website or brand name';

// ── Page transcription (agentic, one page per call) ─────────────────────────

const PAGE_PROMPT = `You are transcribing ONE page of a past-question document, exactly as a meticulous human would.
Tools:
- zoom(bbox): high-resolution crop of part of this page. Use it for small print, formulas, faint or blurred parts, and to check figure edges.
- view_page(offset): the previous (-1) or next (+1) page. Use it only when a question is visibly cut at the top or bottom edge.
- submit(result): your complete transcription. It is validated; if rejected, fix every listed problem and submit again.
If the page is clear, submit directly; do not call tools you do not need.

Structure on this page:
- headings: every heading on this page that starts a new part of the document (a topic, chapter, year/paper, section, answer key, or explanations), in reading order, with refs h1, h2, ... Record printedHeading exactly as printed. A running header/footer repeated on every page is NOT a heading: put it in runningHeader.
- Each question/answer/explanation has headingRef: the ref of the heading it falls under on this page, or "carried" when it comes before any heading on this page (it continues whatever part was open on the previous page).

Transcription rules:
1. Every question on the page, whatever its type (single/multiple choice, true/false, fill in the blank, short answer, essay, matching, structured with parts, calculation). label = the printed question identifier without surrounding punctuation ("1." → "1", "(iv)" → "iv", "Q12" → "12", "3(b)" → "3b"); null only when none is printed. Answer keys and explanations use the same bare form.
2. Text exactly as printed: never paraphrase, summarise, correct or complete it. Keep column reading order. Words the question singles out by underline, bold or italics are wrapped in *single asterisks* (e.g. "nearest in meaning to *audacity*"); no other markup.
3. Mathematics, science notation and chemical formulae in LaTeX ($...$ inline, $$...$$ display).
4. Options: one entry per printed option, printed letter separate from text. Sub-questions go in parts with their labels and marks.
5. Shared passages, instructions and data ("Use the diagram below to answer 12-15") go in passage/instruction of every dependent question.
6. A year/paper/topic tag printed with a question (e.g. "(1994:Q1)") goes in that question's year/sourceRef fields, not in the stem.
7. Figures (diagrams, graphs, charts, tables drawn as figures, maps, structures, circuits, photos): bbox on THIS page image tightly around the whole figure including its own labels and caption, excluding surrounding text. description must let someone who cannot see it understand it fully.
8. Legibility per question: clear/partial/illegible. Write [ILLEGIBLE] where anything cannot be read with certainty (zoom first) and list each region in unclear. Never guess.
9. Continuations: if the top of the page continues a question from the previous page, it is the first item with continuesFromPreviousPage=true (label null unless printed). If the last question continues on the next page, set continuesOnNextPage=true.
10. answer: only when the answer is printed for that question on this page. Answer-key entries go in answers; worked solutions in explanations, each with the label they refer to. Never turn answer keys or explanations into questions. When an entry prints the question number fused with its answer letter (e.g. "32B. Trichloromethane is the impurity…" or "53A. See Q1"), the letter is the ANSWER: record the explanation with label "32" and answerLetters ["B"] (and an answers entry label "32", letters ["B"]). Never leave the letter in the label and never drop it. Tables inside an explanation are transcribed into that explanation's text.
11. Remove page numbers, watermarks, publisher marketing and exam-body branding from question text.
12. pageIssues: anything wrong with the page itself (blur, crop, rotation, bleed-through, handwriting).
13. inventory: before transcribing, scan the WHOLE page (every column, top to bottom) and list every printed question number, answer-key number and explanation number you can see, in bare form. The submission is checked against it: everything in the inventory must be transcribed, and everything transcribed must be in the inventory. Never shorten the inventory to make a submission pass — if a page is long, transcribe all of it.
14. figuresConfirmed: after you submit with figures you are shown the crops of your boxes. If each crop contains its whole figure, submit again unchanged with figuresConfirmed=true; otherwise correct the boxes.`;

function pageResultSchema() {
  const headingRef = enumOf(['carried', ...HEADING_REFS]);
  const option = { type: 'object', additionalProperties: false, required: ['letter', 'text'], properties: { letter: { type: 'string' }, text: { type: 'string' } } };
  const question = {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'headingRef', 'type', 'instruction', 'passage', 'stem', 'options', 'parts', 'marks', 'answer', 'year', 'sourceRef', 'topic', 'subject', 'figures', 'legibility', 'unclear', 'continuesFromPreviousPage', 'continuesOnNextPage', 'confidence'],
    properties: {
      label: { type: ['string', 'null'] },
      headingRef,
      type: enumOf(QUESTION_TYPES),
      instruction: { type: ['string', 'null'] },
      passage: { type: ['string', 'null'] },
      stem: { type: 'string' },
      options: { type: 'array', items: option },
      parts: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['label', 'text', 'marks'], properties: { label: { type: 'string' }, text: { type: 'string' }, marks: { type: ['number', 'null'] } } },
      },
      marks: { type: ['number', 'null'] },
      answer: nullable({
        type: 'object', additionalProperties: false, required: ['letters', 'text'],
        properties: { letters: { type: 'array', items: { type: 'string' } }, text: { type: ['string', 'null'] } },
      }),
      year: { type: ['string', 'null'] },
      sourceRef: { type: ['string', 'null'], description: 'Printed source tag such as "1994:Q1", without exam-body names' },
      topic: { type: ['string', 'null'] },
      subject: { type: ['string', 'null'] },
      figures: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['bbox', 'kind', 'caption', 'description'],
          properties: { bbox: BBOX, kind: enumOf(FIGURE_KINDS), caption: { type: ['string', 'null'] }, description: { type: 'string' } },
        },
      },
      legibility: enumOf(['clear', 'partial', 'illegible']),
      unclear: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['bbox', 'note'], properties: { bbox: BBOX, note: { type: 'string' } } },
      },
      continuesFromPreviousPage: { type: 'boolean' },
      continuesOnNextPage: { type: 'boolean' },
      confidence: { type: 'number', description: '0-1, your confidence the transcription is exact' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['inventory', 'pageType', 'legibility', 'runningHeader', 'headings', 'pageIssues', 'questions', 'answers', 'explanations', 'figuresConfirmed'],
    properties: {
      inventory: {
        type: 'object', additionalProperties: false, required: ['questions', 'answers', 'explanations'],
        description: 'Every printed label visible anywhere on the page, both columns, top to bottom — listed BEFORE transcribing',
        properties: {
          questions: { type: 'array', items: { type: 'string' } },
          answers: { type: 'array', items: { type: 'string' } },
          explanations: { type: 'array', items: { type: 'string' } },
        },
      },
      pageType: enumOf(['questions', 'answer_key', 'explanations', 'front_matter', 'mixed', 'blank', 'unreadable']),
      legibility: enumOf(['clear', 'partial', 'illegible']),
      runningHeader: { type: ['string', 'null'] },
      headings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['ref', 'printedHeading', 'kind', 'year', 'topic', 'subject', 'paperLabel'],
          properties: {
            ref: enumOf(HEADING_REFS),
            printedHeading: { type: 'string' },
            kind: enumOf(SECTION_KINDS),
            year: { type: ['string', 'null'] },
            topic: { type: ['string', 'null'] },
            subject: { type: ['string', 'null'] },
            paperLabel: { type: ['string', 'null'] },
          },
        },
      },
      pageIssues: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['issue', 'note'], properties: { issue: enumOf(PAGE_ISSUES), note: { type: 'string' } } },
      },
      questions: { type: 'array', items: question },
      answers: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['headingRef', 'label', 'letters', 'text'],
          properties: { headingRef, label: { type: 'string' }, letters: { type: 'array', items: { type: 'string' } }, text: { type: ['string', 'null'] } },
        },
      },
      explanations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['headingRef', 'label', 'answerLetters', 'labelHasPartLetter', 'text'],
          properties: {
            headingRef,
            label: { type: 'string', description: 'Question number only, e.g. "6" for an entry printed "6E. ..."' },
            answerLetters: { type: 'array', items: { type: 'string' }, description: 'Answer letter(s) printed with this explanation, e.g. ["E"] for "6E. ..."; [] if none printed' },
            labelHasPartLetter: { type: 'boolean', description: 'true only when a trailing letter in the label is a sub-part of the question (e.g. "3b"), not its answer' },
            text: { type: 'string' },
          },
        },
      },
      figuresConfirmed: { type: 'boolean' },
    },
  };
}

function pageTools({ hasImage }) {
  const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, strict: true, parameters } });
  const tools = [
    fn('submit', 'Submit the complete transcription of this page.', {
      type: 'object', additionalProperties: false, required: ['result'], properties: { result: pageResultSchema() },
    }),
    fn('view_page', 'View the previous (-1) or next (+1) page.', {
      type: 'object', additionalProperties: false, required: ['offset'], properties: { offset: { type: 'integer', enum: [-1, 1] } },
    }),
  ];
  if (hasImage) {
    tools.push(fn('zoom', 'High-resolution crop of a region of this page.', {
      type: 'object', additionalProperties: false, required: ['bbox'], properties: { bbox: BBOX },
    }));
  }
  return tools;
}

// ── Document structure (text-only, windowed) ────────────────────────────────

const STRUCTURE_PROMPT = `You are given, in document order, the headings found on each page of a transcribed past-question document, with a summary of the question numbers, answers and explanations found under each heading. Decide how the document is organised and group the headings into its real sections.

- organizedBy: "topic" (by topic/chapter, possibly mixing years inside), "year" (by exam year/sitting), "paper" (by paper/test without years), or "mixed".
- sections: contiguous runs of nodes, in order, covering every node exactly once. Merge nodes that are the same section (e.g. a heading repeated or continued on the next page); keep genuinely different sections separate.
- title: a neutral display title ${NEUTRAL_TITLE_RULE}.
- kind, year, topic, subject, paperLabel: for the section as a whole (null when not evident).
- answersFor: for answer_key/explanations sections, the localKeys of the question sections in this window, or ids of earlier question sections listed under "earlier", that they answer. If they answer questions that are not in this document, leave answersFor empty and explain in unlinkedReason (otherwise null).
- continuesPrevious: true only for the first section when it continues the last section of the previous window (given as "open").
- documentTitle: neutral, same rule as title.`;

function structureSchema({ nodeIds, earlierIds, hasOpen }) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['organizedBy', 'documentTitle', 'sections'],
    properties: {
      organizedBy: enumOf(['topic', 'year', 'paper', 'mixed']),
      documentTitle: { type: ['string', 'null'] },
      sections: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['localKey', 'nodes', 'continuesPrevious', 'title', 'kind', 'year', 'topic', 'subject', 'paperLabel', 'answersFor', 'unlinkedReason'],
          properties: {
            localKey: { type: 'string' },
            nodes: { type: 'array', items: enumOf(nodeIds) },
            continuesPrevious: hasOpen ? { type: 'boolean' } : { type: 'boolean', enum: [false] },
            title: { type: 'string' },
            kind: enumOf(SECTION_KINDS),
            year: { type: ['string', 'null'] },
            topic: { type: ['string', 'null'] },
            subject: { type: ['string', 'null'] },
            paperLabel: { type: ['string', 'null'] },
            answersFor: { type: 'array', items: { type: 'string' }, description: `localKeys in this window or earlier ids (${earlierIds.slice(-50).join(', ') || 'none'})` },
            unlinkedReason: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
}

// ── Assembly adjudication ───────────────────────────────────────────────────

const ADJUDICATE_PROMPT = `You resolve conflicts found while assembling a transcribed past-question document. For each conflict decide using the text itself:
- duplicate_label: several items share one printed label in one section. Decide which items are the same question captured more than once (keep the most complete, list the others in drop) and which are genuinely different questions (keep them all).
- continuation: one page says its first item continues the previous page, the other page disagrees. Decide whether the fragment belongs to the earlier question (merge) or stands alone (separate).
Explain each decision briefly in reason.`;

function adjudicateSchema({ conflictIds, itemIds }) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['conflictId', 'drop', 'merge', 'reason'],
          properties: { conflictId: enumOf(conflictIds), drop: { type: 'array', items: enumOf(itemIds) }, merge: { type: 'boolean' }, reason: { type: 'string' } },
        },
      },
    },
  };
}

// ── Library classification ──────────────────────────────────────────────────

const LIBRARY_PROMPT = `Classify a transcribed past-question document for a study library. Work only from what is given: the outline and the subject labels attached to its questions.
- canonicalSubjects: map every subject label given to one clean canonical subject name (merge spellings and abbreviations of the same subject).
- catalogGroup: the shelf this document belongs on — its subject, or an accurate collective name if it genuinely spans several subjects.
- streams: broad study streams the subjects belong to, in your own words (lowercase).
- educationLevel: only if evident from the material; else null.
Never name an exam board, institution or country.`;

function librarySchema({ subjectLabels }) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['catalogGroup', 'canonicalSubjects', 'streams', 'educationLevel'],
    properties: {
      catalogGroup: { type: 'string' },
      canonicalSubjects: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['label', 'canonical'], properties: { label: subjectLabels.length ? enumOf(subjectLabels) : { type: 'string' }, canonical: { type: 'string' } } },
      },
      streams: { type: 'array', items: { type: 'string' } },
      educationLevel: { type: ['string', 'null'] },
    },
  };
}

export {
  PAGE_ISSUES,
  QUESTION_TYPES,
  SECTION_KINDS,
  HEADING_REFS,
  PAGE_PROMPT,
  pageResultSchema,
  pageTools,
  STRUCTURE_PROMPT,
  structureSchema,
  ADJUDICATE_PROMPT,
  adjudicateSchema,
  LIBRARY_PROMPT,
  librarySchema,
};
