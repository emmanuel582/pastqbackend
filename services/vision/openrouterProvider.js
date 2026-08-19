import sharp from 'sharp';

function getApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return apiKey;
}

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

const OCR_SIZES = [
  { width: 1600, height: 2200, quality: 85 },
  { width: 1400, height: 1920, quality: 82 },
  { width: 1200, height: 1650, quality: 78 },
];
const OCR_MAX_COMPLETION = 4096;
const OCR_CONTINUES = 4;

async function openrouterFetch(body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pastq.app",
      "X-Title": "PastQ",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter Error ${res.status}: ${text}`);
  }
  return res.json();
}

async function resizeImageBase64(dataUrl, { width, height, quality }) {
  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const metadata = await sharp(buffer).metadata();

  let s = sharp(buffer);
  if (metadata.width > width || metadata.height > height) {
    s = s.resize(width, height, { fit: 'inside', withoutEnlargement: true });
  }
  const out = await s.jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

async function visionOcr(dataUrl, model) {
  let finalMarkdown = '';
  let usageAcc = { promptTokens: 0, completionTokens: 0 };
  let currentImage = dataUrl;

  for (let attempt = 0; attempt < OCR_SIZES.length; attempt++) {
    const size = OCR_SIZES[attempt];
    try {
      currentImage = await resizeImageBase64(dataUrl, size);
      
      const res = await openrouterFetch({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: currentImage } }
            ]
          }
        ],
        max_tokens: OCR_MAX_COMPLETION,
        temperature: 0,
      });

      let content = res.choices?.[0]?.message?.content || '';
      usageAcc.promptTokens += res.usage?.prompt_tokens || 0;
      usageAcc.completionTokens += res.usage?.completion_tokens || 0;

      finalMarkdown = content;

      let continuations = 0;
      while (res.choices?.[0]?.finish_reason === 'length' && continuations < OCR_CONTINUES) {
        continuations++;
        const tail = finalMarkdown.slice(-1500);
        
        const nextRes = await openrouterFetch({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: CONTINUE_PROMPT.replace('{{TAIL}}', tail) },
                { type: 'image_url', image_url: { url: currentImage } }
              ]
            }
          ],
          max_tokens: OCR_MAX_COMPLETION,
          temperature: 0,
        });

        content = nextRes.choices?.[0]?.message?.content || '';
        usageAcc.promptTokens += nextRes.usage?.prompt_tokens || 0;
        usageAcc.completionTokens += nextRes.usage?.completion_tokens || 0;
        finalMarkdown += '\n' + content;
        
        if (nextRes.choices?.[0]?.finish_reason !== 'length') {
          break;
        }
      }

      return {
        pages: [{ markdown: finalMarkdown }],
        usageInfo: { pagesProcessed: 1 },
        usage: usageAcc,
      };

    } catch (err) {
      if (err.message.includes('413') || err.message.includes('too large')) {
        console.warn(`[openrouter] Image too large for ${model} at width ${size.width}, downscaling...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Image too large even at lowest resolution');
}

export async function ocrImage(dataUrl, { model }) {
  return visionOcr(dataUrl, model);
}

export async function ocrPdf(dataUrl, { model }) {
  return visionOcr(dataUrl, model); 
}

export async function chatJson(system, user, { maxTokens, model }) {
  const res = await openrouterFetch({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: maxTokens,
    temperature: 0,
  });

  return {
    content: res.choices?.[0]?.message?.content || '{}',
    usage: {
      promptTokens: res.usage?.prompt_tokens || 0,
      completionTokens: res.usage?.completion_tokens || 0
    },
    model: res.model || model
  };
}
