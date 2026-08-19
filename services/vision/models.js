/**
 * Cost/quality routing for PastQ vision.
 * Default path: OCR → cheap classify/extract on text only.
 * Escalate to a stronger chat model only when confidence is low or extraction looks incomplete.
 *
 * Providers: groq (default for testing) | mistral | gemini (future)
 * Groq picks: qwen/qwen3.6-27b OCR, gpt-oss-20b cheap, gpt-oss-120b strong
 */
const PROVIDER = (process.env.VISION_PROVIDER || 'groq').toLowerCase();
const IS_GROQ = PROVIDER === 'groq';

const GROQ_MODELS = {
  ocr: process.env.VISION_OCR_MODEL || 'qwen/qwen3.6-27b',
  cheap: process.env.VISION_CHEAP_MODEL || 'openai/gpt-oss-20b',
  strong: process.env.VISION_STRONG_MODEL || 'openai/gpt-oss-120b',
};

const MISTRAL_MODELS = {
  ocr: process.env.VISION_OCR_MODEL || 'mistral-ocr-latest',
  cheap: process.env.VISION_CHEAP_MODEL || 'mistral-small-latest',
  strong: process.env.VISION_STRONG_MODEL || 'mistral-medium-latest',
};

const MODELS = IS_GROQ ? GROQ_MODELS : MISTRAL_MODELS;

/** Approx USD pricing used for session cost logs (not billing truth). */
const PRICING = IS_GROQ
  ? {
      // qwen vision OCR ~2k tokens/page rough estimate
      ocrPerPage: 0.002,
      cheap: {
        chatInput: 0.075 / 1_000_000,
        chatOutput: 0.3 / 1_000_000,
      },
      strong: {
        chatInput: 0.15 / 1_000_000,
        chatOutput: 0.6 / 1_000_000,
      },
    }
  : {
      ocrPerPage: 4 / 1000,
      cheap: {
        chatInput: 0.2 / 1_000_000,
        chatOutput: 0.6 / 1_000_000,
      },
      strong: {
        chatInput: 1.5 / 1_000_000,
        chatOutput: 7.5 / 1_000_000,
      },
    };

const USD_TO_NGN = Number(process.env.USD_TO_NGN || 1400);

/** Image prep: keep exam pages sharp. Groq TPM is handled by completion size, not downscaling. */
const IMAGE_PREP = {
  maxWidth: Number(process.env.VISION_MAX_WIDTH || 1600),
  maxHeight: Number(process.env.VISION_MAX_HEIGHT || 2200),
  jpegQuality: Number(process.env.VISION_JPEG_QUALITY || 85),
};

function pricingForModel(model) {
  if (model === MODELS.strong) return PRICING.strong;
  return PRICING.cheap;
}

/**
 * Decide if extract should be re-run with the strong model.
 * Prefer abstaining / review flags over paying Pro on every page.
 */
function needsStrongExtract(ocrMarkdown, classified, extracted) {
  const conf = typeof classified?.confidence === 'number' ? classified.confidence : 1;
  if (conf < 0.55) return { yes: true, reason: 'low_classify_confidence' };

  const qs = Array.isArray(extracted?.questions) ? extracted.questions : [];
  const qMarks = (ocrMarkdown.match(/(?:^|\n)\s*(?:\d{1,3}|[Qq]\.?\s*\d{1,3})[\.\)\:]/gm) || []).length;

  if (qMarks >= 2 && qs.length === 0) {
    return { yes: true, reason: 'ocr_has_questions_extract_empty' };
  }
  if (qMarks >= 4 && qs.length > 0 && qs.length < Math.floor(qMarks * 0.4)) {
    return { yes: true, reason: 'extract_count_far_below_ocr_markers' };
  }

  const weak = qs.filter(
    (q) =>
      (typeof q.confidence === 'number' && q.confidence < 0.55) ||
      (Array.isArray(q.options) && q.options.filter(Boolean).length < 2 && !q.isContinuation) ||
      (!String(q.question || '').trim() && !q.isContinuation)
  );
  if (qs.length && weak.length >= Math.ceil(qs.length * 0.5)) {
    return { yes: true, reason: 'many_weak_questions' };
  }

  // Dense page: long OCR + many markers — worth one strong pass if cheap pass looks thin
  if (ocrMarkdown.length > 3500 && qMarks >= 6 && qs.length <= 2) {
    return { yes: true, reason: 'dense_page_thin_extract' };
  }

  return { yes: false, reason: null };
}

/** Skip LLM entirely for obvious junk after OCR. */
function heuristicPageType(ocrMarkdown) {
  const text = (ocrMarkdown || '').trim();
  if (text.length < 40) return { pageType: 'blank', confidence: 0.95, reason: 'too_short' };

  const lower = text.toLowerCase();
  const coverHits = [
    'table of contents',
    'all rights reserved',
    'published by',
    'isbn',
    'copyright',
    'acknowledgement',
    'foreword',
  ].filter((k) => lower.includes(k)).length;
  const hasQuestionShape = /(?:^|\n)\s*(?:\d{1,3}|[Qq]\s*\d{1,3})[\.\)\:]/.test(text);
  const hasOptions = /(?:^|\n)\s*[A-Ea-e][\.\)\:]\s+\S+/.test(text);

  if (coverHits >= 2 && !hasQuestionShape && !hasOptions) {
    return { pageType: 'cover_toc', confidence: 0.9, reason: 'cover_keywords' };
  }
  return null;
}

export {
  PROVIDER,
  IS_GROQ,
  MODELS,
  PRICING,
  USD_TO_NGN,
  IMAGE_PREP,
  pricingForModel,
  needsStrongExtract,
  heuristicPageType,
};
