/**
 * AI library taxonomy classifier — university → exam type → manufacturer.
 * Uses LLM only (no regex taxonomy). Falls back to uploader name when no booklet label found.
 */
import * as openrouterProvider from './openrouterProvider.js';
import * as groqProvider from './groq.js';

const SYSTEM_PROMPT = `You classify Nigerian exam past-question uploads for a CBT library.

Return ONLY valid JSON with these fields:
{
  "university": "Full university name e.g. University of Ibadan",
  "examType": "Short exam label e.g. UI Post UTME, JAMB UTME, WAEC SSCE",
  "manufacturer": "Publisher/booklet brand name e.g. Primax Preversity, Success Tutorial",
  "manufacturerConfidence": 0.0 to 1.0,
  "manufacturerSource": "booklet_label" or "uploader"
}

Rules:
- Detect university from headers (OAU, UI, UNILAG, etc.) — expand abbreviations to full names.
- examType should be specific: "UI Post UTME" not just "Post UTME" when university is known.
- manufacturer = booklet publisher/brand printed on the material (Primax, Success Tutorial, Pass.ng, etc.)
- If NO publisher label is visible in the OCR sample, set manufacturerSource to "uploader" and manufacturer to the uploader name provided.
- Never merge different publishers — pick the one visible on THIS upload.
- Nigerian context: JAMB, WAEC, NECO, Post-UTME, Post-UME screening.`;

function parseJsonContent(raw) {
  const text = String(raw || '{}').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return {};
}

async function callLlm(system, user) {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const res = await openrouterProvider.chatJson(system, user, {
        maxTokens: 1024,
        model: process.env.VISION_CHEAP_MODEL || 'google/gemini-2.5-flash',
      });
      return parseJsonContent(res.content);
    } catch (err) {
      console.warn('[library-classifier] OpenRouter failed:', err.message);
    }
  }
  if (process.env.GROQ_API_KEY) {
    try {
      const res = await groqProvider.chatJson(system, user, {
        maxTokens: 1024,
        model: process.env.VISION_CHEAP_MODEL || 'openai/gpt-oss-20b',
      });
      return parseJsonContent(res.content);
    } catch (err) {
      console.warn('[library-classifier] Groq failed:', err.message);
    }
  }
  return null;
}

function buildSample(session) {
  const ocrChunks = (session.pages || [])
    .filter((p) => p.ocrMarkdown && p.ocrMarkdown.length > 20)
    .slice(0, 3)
    .map((p) => p.ocrMarkdown.slice(0, 800));

  const questionSamples = (session.questions || [])
    .slice(0, 8)
    .map((q) => ({
      subject: q.subject,
      year: q.year,
      paper: q.paper,
      question: String(q.question || '').slice(0, 120),
    }));

  const papers = [...new Set((session.groups || []).map((g) => g.paper).filter(Boolean))];
  const years = [...new Set((session.questions || []).map((q) => q.year).filter(Boolean))];

  return {
    sessionName: session.name,
    subjectHint: session.subjectHint,
    ocrSample: ocrChunks.join('\n---\n').slice(0, 2400),
    questionSamples,
    papers,
    years,
  };
}

function fallbackMeta(session, uploaderName) {
  const name = uploaderName || session.uploaderName || 'Student';
  return {
    university: session.subjectHint?.includes('UI') ? 'University of Ibadan' : 'General',
    examType: session.subjectHint || 'Past Questions',
    manufacturer: `Upload by ${name}`,
    manufacturerConfidence: 0.3,
    manufacturerSource: 'uploader',
  };
}

/**
 * Classify a completed extraction session into library hierarchy fields.
 * @param {Object} session - Vision session with questions/pages
 * @param {{ uploaderName?: string, uploaderEmail?: string }} [context]
 */
export async function classifyLibrarySession(session, context = {}) {
  if (session.libraryMeta?.university && session.libraryMeta?.manufacturer) {
    return session.libraryMeta;
  }

  const uploaderName =
    context.uploaderName ||
    session.uploaderName ||
    (context.uploaderEmail ? context.uploaderEmail.split('@')[0] : null) ||
    'Student';

  const sample = buildSample(session);
  const userPrompt = `Classify this past-question upload:

Session name: ${sample.sessionName || 'Untitled'}
Subject hint: ${sample.subjectHint || 'none'}
Uploader (fallback manufacturer): ${uploaderName}

OCR text sample:
${sample.ocrSample || '(no OCR)'}

Question samples: ${JSON.stringify(sample.questionSamples)}
Papers detected: ${sample.papers.join(', ') || 'none'}
Years detected: ${sample.years.join(', ') || 'none'}`;

  let parsed = await callLlm(SYSTEM_PROMPT, userPrompt);

  if (!parsed || !parsed.university) {
    parsed = fallbackMeta(session, uploaderName);
  }

  if (parsed.manufacturerSource !== 'booklet_label' || !parsed.manufacturer?.trim()) {
    parsed.manufacturer = parsed.manufacturer?.trim() || `Upload by ${uploaderName}`;
    parsed.manufacturerSource = 'uploader';
    parsed.manufacturerConfidence = Math.min(parsed.manufacturerConfidence ?? 0.3, 0.5);
  }

  const meta = {
    university: String(parsed.university || 'General').trim(),
    examType: String(parsed.examType || 'Past Questions').trim(),
    manufacturer: String(parsed.manufacturer).trim(),
    manufacturerConfidence: Number(parsed.manufacturerConfidence) || 0.5,
    manufacturerSource: parsed.manufacturerSource === 'booklet_label' ? 'booklet_label' : 'uploader',
    classifiedAt: new Date().toISOString(),
  };

  return meta;
}

export function manufacturerKey(meta) {
  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${slug(meta.university)}::${slug(meta.examType)}::${slug(meta.manufacturer)}`;
}
