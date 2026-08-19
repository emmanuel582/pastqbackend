import fs from "node:fs/promises";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  const sec = Number(value || "");
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
}

function nextBackoffMs(attempt) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.round(Math.random() * 450);
}

function extractJsonText(responseData) {
  const content = responseData?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part?.type === "text" && typeof part?.text === "string");
    return textPart?.text ?? "";
  }
  return "";
}

function buildSchema() {
  return {
    name: "question_extraction",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["questions", "quality"],
      properties: {
        quality: {
          type: "object",
          additionalProperties: false,
          required: ["score", "notes"],
          properties: {
            score: { type: "number", minimum: 0, maximum: 1 },
            notes: { type: "string" }
          }
        },
        questions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["questionNumber", "questionText", "options"],
            properties: {
              questionNumber: { type: "string" },
              questionText: { type: "string" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                items: { type: "string" }
              },
              year: { type: "string" },
              paper: { type: "string" },
              subject: { type: "string" },
            }
          }
        }
      }
    }
  };
}

function buildPrompt(pageNumber, totalPages) {
  return [
    `You are extracting exam questions for a CBT app.`,
    `Task: read page ${pageNumber} of ${totalPages} and extract ONLY what is visibly present.`,
    `Rules:`,
    `1) Do NOT solve questions.`,
    `2) Do NOT extract correct answers/answer keys/explanations—only the question stem and its options.`,
    `3) Do NOT invent options.`,
    `4) Keep punctuation and math symbols exactly as seen.`,
    `5) Ignore any text fragments that clearly belong to another page (for example: cut-off blocks from the next/previous page, margins that include adjacent page content, or partial duplicates).`,
    `6) If a question continues across pages, include ONLY the portion that is clearly visible on THIS page; do not stitch/merge across page boundaries using guesses.`,
    `7) Return empty questions array if the page has no questions.`,
    `8) Prioritize OCR accuracy over brevity.`
  ].join("\n");
}

export async function extractQuestionsFromImage({
  filePath,
  mimeType,
  model,
  openRouterApiKey,
  baseUrl,
  appName,
  appBaseUrl,
  pageNumber,
  totalPages,
  maxAttempts,
  maxTokens
}) {
  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }
  const imageBuffer = await fs.readFile(filePath);
  const imageBase64 = imageBuffer.toString("base64");
  const imageDataUrl = `data:${mimeType};base64,${imageBase64}`;
  const schema = buildSchema();

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": appBaseUrl,
          "X-Title": appName
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 8192,
          provider: {
            require_parameters: true
          },
          response_format: {
            type: "json_schema",
            json_schema: schema
          },
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: buildPrompt(pageNumber, totalPages) },
                { type: "image_url", image_url: { url: imageDataUrl } }
              ]
            }
          ]
        })
      });

      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const payload = await res.text();
        const error = new Error(`OpenRouter error ${res.status}: ${payload.slice(0, 500)}`);
        error.status = res.status;
        lastError = error;
        if (res.status === 429 || res.status === 503 || res.status === 502) {
          await sleep(retryAfterMs ?? nextBackoffMs(attempt));
          continue;
        }
        throw error;
      }

      const data = await res.json();
      const raw = extractJsonText(data);
      const parsed = JSON.parse(raw);

      return {
        parsed,
        usage: data?.usage || null
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts - 1) break;
      await sleep(nextBackoffMs(attempt));
    }
  }

  throw lastError || new Error("Extraction failed");
}
