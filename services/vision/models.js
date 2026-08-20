
const PROVIDER = (process.env.VISION_PROVIDER || 'hybrid').toLowerCase();
const IS_GROQ = PROVIDER === 'groq';
const IS_OPENROUTER = PROVIDER === 'openrouter';
const IS_HYBRID = PROVIDER === 'hybrid';
const IS_MISTRAL = PROVIDER === 'mistral';

const GROQ_MODELS = {
  ocr: process.env.VISION_OCR_MODEL || 'qwen/qwen3.6-27b',
  cheap: process.env.VISION_CHEAP_MODEL || 'openai/gpt-oss-20b',
  strong: process.env.VISION_STRONG_MODEL || 'openai/gpt-oss-120b',
};

const OPENROUTER_MODELS = {
  ocr: process.env.VISION_OCR_MODEL || 'google/gemini-2.5-flash',
  cheap: process.env.VISION_CHEAP_MODEL || 'google/gemini-2.5-flash',
  strong: process.env.VISION_STRONG_MODEL || 'google/gemini-2.5-flash',
};

const MISTRAL_MODELS = {
  ocr: process.env.VISION_OCR_MODEL || 'mistral-ocr-latest',
  cheap: process.env.VISION_CHEAP_MODEL || 'mistral-small-latest',
  strong: process.env.VISION_STRONG_MODEL || 'mistral-medium-latest',
};

/**
 * Hybrid models — optimal quality and cost:
 * - OCR: Mistral's dedicated OCR (top-tier document vision)
 * - Cheap classify/extract: Mistral Small (high-speed, low-cost structured JSON)
 * - Strong escalation: Gemini Flash via OpenRouter (deep reasoning for complex pages)
 */
const HYBRID_MODELS = {
  ocr: process.env.VISION_OCR_MODEL || 'mistral-ocr-latest',
  cheap: process.env.VISION_CHEAP_MODEL || 'mistral-small-latest',
  strong: process.env.VISION_STRONG_MODEL || 'google/gemini-2.5-flash',
};

function selectModels() {
  if (IS_HYBRID) return HYBRID_MODELS;
  if (IS_OPENROUTER) return OPENROUTER_MODELS;
  if (IS_GROQ) return GROQ_MODELS;
  return MISTRAL_MODELS;
}

const MODELS = selectModels();

/**
 * Which provider handles each stage in hybrid mode.
 * Returns 'mistral' | 'openrouter' | 'groq'
 */
function providerForStage(stage) {
  if (!IS_HYBRID) return PROVIDER;
  switch (stage) {
    case 'ocr':
      return 'mistral';   // Mistral OCR endpoint — $0.004/page
    case 'cheap':
    case 'classify':
    case 'extract':
      return 'mistral';   // Mistral Small — $0.15/$0.60 per 1M tokens
    case 'strong':
      return 'openrouter'; // Gemini Flash via OR — $0.30/$2.50 per 1M tokens
    default:
      return 'mistral';
  }
}

/** Approx USD pricing used for session cost logs */
const PRICING = IS_GROQ
  ? {
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
  : IS_OPENROUTER ? {
    ocrPerPage: 0,
    cheap: { chatInput: 0.3 / 1_000_000, chatOutput: 2.5 / 1_000_000 },
    strong: { chatInput: 0.3 / 1_000_000, chatOutput: 2.5 / 1_000_000 },
  } : {
    ocrPerPage: 4 / 1000,      // $0.004/page
    cheap: {
      chatInput: 0.15 / 1_000_000,    // Mistral Small
      chatOutput: 0.6 / 1_000_000,
    },
    strong: IS_HYBRID ? {
      chatInput: 0.3 / 1_000_000,     // Gemini Flash via OpenRouter
      chatOutput: 2.5 / 1_000_000,
    } : {
      chatInput: 1.5 / 1_000_000,     // Mistral Medium
      chatOutput: 7.5 / 1_000_000,
    },
  };

const USD_TO_NGN = Number(process.env.USD_TO_NGN || 1400);

const IMAGE_PREP = {
  maxWidth: Number(process.env.VISION_MAX_WIDTH || 2048),
  maxHeight: Number(process.env.VISION_MAX_HEIGHT || 2800),
  jpegQuality: Number(process.env.VISION_JPEG_QUALITY || 90),
};

/** Default 1: sequential extract avoids year/openQuestion races on multi-year PDFs. */
const CONCURRENCY = Number(process.env.VISION_CONCURRENCY || 1);
const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.VISION_CIRCUIT_BREAKER || 5);

/** Used when hybrid strong (OpenRouter) is unavailable — never demote to Small. */
const STRONG_FALLBACK_MODEL =
  process.env.VISION_STRONG_FALLBACK_MODEL || 'mistral-medium-latest';

function pricingForModel(model) {
  if (model === MODELS.strong || model === STRONG_FALLBACK_MODEL) return PRICING.strong;
  return PRICING.cheap;
}

/**
 * Decide if extract should be re-run with the strong reasoning model.
 * Evaluates semantic extraction confidence and completeness.
 */
function needsStrongExtract(ocrMarkdown, classified, extracted) {
  const conf = typeof classified?.confidence === 'number' ? classified.confidence : 1;
  if (conf < 0.55) return { yes: true, reason: 'low_classify_confidence' };

  const qs = Array.isArray(extracted?.questions) ? extracted.questions : [];

  if (classified?.pageType === 'question_content' && qs.length === 0 && ocrMarkdown.length > 200) {
    return { yes: true, reason: 'question_content_yielded_zero_questions' };
  }

  const weak = qs.filter(
    (q) =>
      (typeof q.confidence === 'number' && q.confidence < 0.55) ||
      (Array.isArray(q.options) && q.options.filter(Boolean).length < 2 && !q.isContinuation) ||
      (!String(q.question || '').trim() && !q.isContinuation)
  );

  if (qs.length > 0 && weak.length >= Math.ceil(qs.length * 0.5)) {
    return { yes: true, reason: 'high_proportion_of_low_confidence_questions' };
  }

  return { yes: false, reason: null };
}

/** Skip LLM entirely only for genuinely blank pages. */
function heuristicPageType(ocrMarkdown) {
  const text = (ocrMarkdown || '').trim();
  if (text.length < 20) return { pageType: 'blank', confidence: 0.98, reason: 'blank_or_negligible_text' };
  return null;
}

export {
  PROVIDER,
  IS_GROQ,
  IS_OPENROUTER,
  IS_HYBRID,
  IS_MISTRAL,
  MODELS,
  PRICING,
  USD_TO_NGN,
  IMAGE_PREP,
  CONCURRENCY,
  CIRCUIT_BREAKER_THRESHOLD,
  STRONG_FALLBACK_MODEL,
  pricingForModel,
  providerForStage,
  needsStrongExtract,
  heuristicPageType,
};
