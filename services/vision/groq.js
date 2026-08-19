/**
 * Groq provider for PastQ vision pipeline.
 * OCR: qwen/qwen3.6-27b (vision) — https://console.groq.com/docs/vision
 * Reasoning: gpt-oss-20b (cheap) / gpt-oss-120b (strong) — https://console.groq.com/docs/reasoning
 *
 * Free/on_demand Qwen TPM is 8000. Groq counts input + max_completion_tokens.
 * A 1600px exam page is only ~2.5k input; 8192 completion was what blew the cap.
 * Keep image quality high and continue if output hits the completion limit.
 */
import Groq from 'groq-sdk';
import sharp from 'sharp';

const OCR_PROMPT = `You are a precise OCR engine for exam past-question pages.

Extract ALL visible text from this image exactly as printed. Use markdown formatting:
- Preserve question numbers (1., 2., Q1, etc.)
- Preserve option letters (A., B., C., D., E.) on separate lines
- Keep headers, footers, year/paper labels, subject names, instructions
- Preserve reading order (top-to-bottom; left column then right column if two columns)
- Transcribe every question and every option on the page — do not skip, summarize, or stop early
- If text is faint or cropped, transcribe what is visible rather than inventing
- Do NOT add commentary
- Output ONLY the transcribed text in markdown`;

const CONTINUE_PROMPT = `The previous transcription was cut off. Continue EXACTLY from where it ended.
Do not repeat text already transcribed. Do not summarize. Markdown only.
The transcription so far ends with:

<<<
{{TAIL}}
>>>`;

/** Prefer full exam-page resolution. Smaller sizes are fallbacks for 413 TPM only. */
const OCR_SIZES = [
  { width: 1600, height: 2200, quality: 85 },
  { width: 1400, height: 1920, quality: 82 },
  { width: 1200, height: 1650, quality: 78 },
];
const OCR_MAX_COMPLETION = 4096;
const OCR_CONTINUES = 4;

function getGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  return new Groq({ apiKey });
}

function normalizeUsage(usage) {
  if (!usage) return { promptTokens: 0, completionTokens: 0 };
  return {
    promptTokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
  };
}

function addUsage(a, b) {
  return {
    promptTokens: (a?.promptTokens || 0) + (b?.promptTokens || 0),
    completionTokens: (a?.completionTokens || 0) + (b?.completionTokens || 0),
  };
}

function extractContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return String(content || '');
}

function toOcrResponse(markdown, { pagesProcessed = 1, usage } = {}) {
  return {
    pages: [{ markdown: markdown || '' }],
    usageInfo: { pagesProcessed },
    usage,
  };
}

function isRequestTooLarge(err) {
  const msg = err?.message || String(err);
  return err?.status === 413 || /request too large/i.test(msg);
}

function mergeOcrChunks(a, b) {
  if (!b) return a;
  if (!a) return b;
  const max = Math.min(a.length, b.length, 500);
  for (let n = max; n >= 32; n--) {
    if (b.startsWith(a.slice(-n))) return a + b.slice(n);
  }
  return `${a}\n${b}`;
}

async function shrinkDataUrl(dataUrl, { width, height, quality }) {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const buf = Buffer.from(base64, 'base64');
  const jpeg = await sharp(buf, { unlimited: true })
    .rotate()
    .resize({
      width,
      height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function ocrCreateOpts(model, messages) {
  return {
    model,
    temperature: 0,
    max_completion_tokens: OCR_MAX_COMPLETION,
    reasoning_effort: 'none',
    reasoning_format: 'hidden',
    messages,
  };
}

async function continueOcr(groq, model, url, firstChoice, firstUsage, label) {
  let markdown = extractContent(firstChoice?.message).trim();
  let usage = firstUsage || { promptTokens: 0, completionTokens: 0 };
  let finish = firstChoice?.finish_reason;
  let n = 0;

  while (finish === 'length' && n < OCR_CONTINUES) {
    n += 1;
    const tail = markdown.slice(-700);
    console.warn(`[groq-ocr] ${label} truncated; continuation ${n}`);
    const response = await groq.chat.completions.create(
      ocrCreateOpts(model, [
        {
          role: 'user',
          content: [
            { type: 'text', text: CONTINUE_PROMPT.replace('{{TAIL}}', tail) },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ])
    );
    const more = extractContent(response.choices?.[0]?.message).trim();
    markdown = mergeOcrChunks(markdown, more);
    usage = addUsage(usage, normalizeUsage(response.usage));
    finish = response.choices?.[0]?.finish_reason;
  }

  if (finish === 'length') {
    console.warn(`[groq-ocr] ${label} still truncated after ${n} continuations`);
  }
  return { markdown, usage };
}

async function visionOcr(dataUrl, { model, label = 'groq-ocr' }) {
  const groq = getGroq();
  let lastErr;
  for (const size of OCR_SIZES) {
    const url = await shrinkDataUrl(dataUrl, size);
    try {
      const response = await groq.chat.completions.create(
        ocrCreateOpts(model, [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ])
      );
      const continued = await continueOcr(
        groq,
        model,
        url,
        response.choices?.[0],
        normalizeUsage(response.usage),
        label
      );
      console.log(`[groq-ocr] ${label} ok at ${size.width}x${size.height} chars=${continued.markdown.length}`);
      return toOcrResponse(continued.markdown, {
        pagesProcessed: 1,
        usage: continued.usage,
      });
    } catch (err) {
      lastErr = err;
      if (isRequestTooLarge(err)) {
        console.warn(`[groq-ocr] ${label} ${size.width}x${size.height} over TPM; trying next size`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function pdfBufferToPageImages(buffer) {
  const { pdf } = await import('pdf-to-img');
  const pages = [];
  for await (const image of await pdf(buffer, { scale: 2 })) {
    pages.push(image);
  }
  return pages;
}

async function ocrImage(dataUrl, { model }) {
  return visionOcr(dataUrl, { model, label: 'groq-ocr-image' });
}

async function ocrPdf(dataUrl, { model }) {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const buffer = Buffer.from(base64, 'base64');
  const pageImages = await pdfBufferToPageImages(buffer);

  if (!pageImages.length) {
    throw new Error('PDF has no renderable pages');
  }

  const pages = [];
  let totalUsage = { promptTokens: 0, completionTokens: 0 };

  for (let i = 0; i < pageImages.length; i++) {
    const pageDataUrl = `data:image/png;base64,${pageImages[i].toString('base64')}`;
    const result = await visionOcr(pageDataUrl, { model, label: `groq-ocr-pdf-${i + 1}` });
    pages.push({ markdown: result.pages[0]?.markdown || '' });
    totalUsage = addUsage(totalUsage, result.usage);
  }

  return {
    pages,
    usageInfo: { pagesProcessed: pages.length },
    usage: totalUsage,
  };
}

function chatOptionsForModel(model, { maxTokens, jsonMode }) {
  const opts = {
    temperature: 0,
    max_completion_tokens: Math.min(maxTokens, 4096),
  };

  if (jsonMode) {
    opts.response_format = { type: 'json_object' };
  }

  if (model.includes('gpt-oss')) {
    opts.reasoning_effort = model.includes('120b') ? 'medium' : 'low';
  } else if (model.includes('qwen')) {
    opts.reasoning_effort = 'none';
    opts.reasoning_format = jsonMode ? 'parsed' : 'hidden';
  }

  return opts;
}

function looksTruncatedJson(text) {
  if (!text) return true;
  const trimmed = text.trim();
  const opens = (trimmed.match(/\{/g) || []).length;
  const closes = (trimmed.match(/\}/g) || []).length;
  return opens > closes || !trimmed.endsWith('}') && !trimmed.endsWith(']');
}

async function chatJson(system, user, { maxTokens = 8192, model } = {}) {
  const groq = getGroq();
  const opts = chatOptionsForModel(model, { maxTokens, jsonMode: true });
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let response = await groq.chat.completions.create({ model, messages, ...opts });
  let content = extractContent(response.choices?.[0]?.message);
  let usage = normalizeUsage(response.usage);
  let finish = response.choices?.[0]?.finish_reason;
  let n = 0;

  while ((finish === 'length' || looksTruncatedJson(content)) && n < 3) {
    n += 1;
    console.warn(`[groq-chat] ${model} JSON truncated; continuation ${n}`);
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content:
        'Continue the JSON object from exactly where it was cut off. Do not restart. Do not wrap in markdown. Output only the remaining JSON text.',
    });
    response = await groq.chat.completions.create({ model, messages, ...opts });
    const more = extractContent(response.choices?.[0]?.message);
    content = mergeOcrChunks(content, more);
    usage = addUsage(usage, normalizeUsage(response.usage));
    finish = response.choices?.[0]?.finish_reason;
    if (finish !== 'length' && !looksTruncatedJson(content)) break;
  }

  return {
    content,
    usage,
    model,
  };
}

export {
  ocrImage,
  ocrPdf,
  chatJson,
};
