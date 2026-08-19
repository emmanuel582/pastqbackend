const CLASSIFY_PROMPT = `You classify OCR text from one page of a past-question book or exam paper.

Return JSON only:
{
  "pageType": "question_content" | "answer_key" | "cover_toc" | "unclear" | "blank",
  "confidence": 0.0-1.0,
  "detectedYear": string|null,
  "detectedPaper": string|null,
  "reason": string,
  "needsClearerImage": boolean
}

Rules:
- question_content: page has exam questions / MCQ stems / options (even if partial continuation)
- answer_key: page is mainly answer keys (e.g. "1. A  2. C", "Answers", marking scheme) with little/no full question stems
- cover_toc: cover, title page, table of contents, ads, copyright — skip for extraction
- blank: empty / almost no usable text
- unclear: text too garbled/blurry to trust — set needsClearerImage true
- detectedYear: year heading if visible (e.g. "2026", "June 2025") else null
- detectedPaper: paper/variant if visible (e.g. "A", "B", "Paper 1", "May/June") else null
- Prefer abstaining (unclear) over guessing when OCR is garbage.`;

const EXTRACT_PROMPT = `You are an elite past-question extractor for CBT conversion.

You receive OCR markdown from ONE page plus SESSION MEMORY from prior pages.
Extract multiple-choice questions with absolute fidelity. Never invent missing options or answers.

Return JSON:
{
  "pageMeta": {
    "year": string|null,
    "paper": string|null,
    "isContinuation": boolean,
    "answersMixedOnPage": boolean
  },
  "questions": [
    {
      "questionNumber": number|null,
      "subject": string,
      "question": string,
      "options": string[],
      "correct": number|null,
      "explanation": string,
      "confidence": number,
      "needsReview": boolean,
      "isContinuation": boolean,
      "incomplete": boolean
    }
  ],
  "openQuestionCarry": {
    "questionNumber": number|null,
    "subject": string,
    "question": string,
    "options": string[],
    "correct": number|null,
    "explanation": string,
    "year": string|null,
    "paper": string|null,
    "incomplete": true
  } | null,
  "followUps": [ { "type": string, "message": string } ]
}

CRITICAL RULES:
1. Transcribe EXACTLY from OCR. Do not paraphrase.
2. options: array of choice texts WITHOUT A/B/C/D prefixes. Prefer 4 options; if fewer exist, keep what is present; NEVER invent options.
3. correct: zero-based index ONLY if the page clearly marks the answer on this page. Otherwise null. Do NOT guess by reasoning. Wrong keys are worse than missing keys.
4. NEVER put answer letters or answer-key text inside "question".
5. If answers appear beside options on the same page, set answersMixedOnPage true, put correct index if unambiguous, strip answer marks from option text.
6. Continuation: if the page starts mid-stem/mid-options with no new question number, set isContinuation true and either merge into openQuestionCarry from memory or return one continuation question with isContinuation true.
7. If a question is cut off at page end, set incomplete true and put it in openQuestionCarry (and still include it in questions if it has usable stem text).
8. Inherit year/paper from SESSION MEMORY when the page has no new heading.
9. Prefer needsReview true + followUps over hallucinating. If OCR is ambiguous, extract what you can and flag needsReview.
10. explanation: only if grounded in provided answer key text; else "".
11. Set confidence honestly (0-1). Low confidence is expected when text is messy — do not overstate certainty.
12. Return questions in the SAME top-to-bottom order they appear on the page (Q1 before Q2, etc.). Never shuffle.`;

const ANSWER_KEY_PROMPT = `Extract answer keys ONLY from OCR of an answers page/section.

Return JSON:
{
  "year": string|null,
  "paper": string|null,
  "answers": [
    { "questionNumber": number, "correctLetter": "A"|"B"|"C"|"D"|"E"|string, "correctIndex": number|null }
  ],
  "followUps": [ { "type": string, "message": string } ]
}

Rules:
- Map letters A=0, B=1, C=2, D=3, E=4 into correctIndex when possible.
- Never invent answers not present in OCR.
- Preserve year/paper if headings exist; else null.
- Ignore full question stems; only answer mappings.`;

function buildMemoryBlock(memory) {
  const m = memory || {};
  return `SESSION MEMORY:
- activeYear: ${m.activeYear ?? 'null'}
- activePaper: ${m.activePaper ?? 'null'}
- answersSectionStarted: ${!!m.answersSectionStarted}
- recentQuestionNumbers: ${JSON.stringify(m.recentQuestionNumbers || [])}
- countsByGroup: ${JSON.stringify(m.countsByGroup || {})}
- openQuestion: ${m.openQuestion ? JSON.stringify(m.openQuestion) : 'null'}
- lastHeadings: ${JSON.stringify(m.lastHeadings || [])}`;
}

module.exports = {
  CLASSIFY_PROMPT,
  EXTRACT_PROMPT,
  ANSWER_KEY_PROMPT,
  buildMemoryBlock,
};
