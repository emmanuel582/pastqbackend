/**
 * OpenRouter client for the vision pipeline.
 *
 * - Strict JSON-schema output only. No lenient parsing: output that is not
 *   valid JSON is an error the caller must repair or surface.
 * - Every failure is a typed ProviderError carrying the HTTP status, so retry
 *   and pause decisions are made from protocol facts, not message text.
 */
import sharp from 'sharp';

// Hard ceiling per request, and the longest silence tolerated on a stream
// Reasoning models can stay silent for minutes before the first token, so the
// idle limit is generous; the hard ceiling still bounds a dead call.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 1800000);
const IDLE_TIMEOUT_MS = Number(process.env.OPENROUTER_IDLE_TIMEOUT_MS || 600000);

class ProviderError extends Error {
  /**
   * kind: 'auth' | 'credits' | 'rate_limit' | 'server' | 'timeout' | 'network'
   *     | 'bad_request' | 'truncated' | 'invalid_output' | 'refused'
   */
  constructor(kind, message, { status = null, body = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.body = body;
    /** Seconds the provider asked us to wait (Retry-After), when given. */
    this.retryAfter = retryAfter;
  }

  /** Transient failures worth retrying with backoff. */
  get retryable() {
    return ['rate_limit', 'server', 'timeout', 'network'].includes(this.kind);
  }

  /** Failures that no retry can fix until a human acts (key, credits). */
  get pausesSession() {
    return ['auth', 'credits'].includes(this.kind);
  }
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credits';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function getApiKey() {
  const key = String(process.env.OPENROUTER_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!key) throw new ProviderError('auth', 'OPENROUTER_API_KEY is not set');
  return key;
}

export function openRouterKeyFingerprint() {
  try {
    const k = getApiKey();
    return `…${k.slice(-4)} (len=${k.length})`;
  } catch {
    return 'MISSING';
  }
}

function upstreamError(error) {
  const status = Number(error?.code) || 502;
  return new ProviderError(kindForStatus(status), `OpenRouter upstream error ${status}: ${error?.message || 'unknown'}`, { status, body: error });
}

/**
 * Fold a server-sent-event stream of chat.completion.chunk objects into one
 * completion object (same shape as a non-streamed response).
 */
async function readStream(res, onActivity) {
  const decoder = new TextDecoder();
  const message = { role: 'assistant', content: '', tool_calls: [] };
  const out = { model: null, usage: null, choices: [{ message, finish_reason: null }] };
  let buffer = '';
  for await (const chunk of res.body) {
    onActivity();
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      // Blank lines separate events; lines starting with ':' are keep-alive comments.
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return out;
      let evt;
      try { evt = JSON.parse(data); } catch {
        throw new ProviderError('server', `OpenRouter sent an unreadable stream event: ${data.slice(0, 200)}`);
      }
      if (evt.error) throw upstreamError(evt.error);
      if (evt.model) out.model = evt.model;
      if (evt.usage) out.usage = evt.usage;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) out.choices[0].finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) message.content += delta.content;
      if (delta.refusal) message.refusal = (message.refusal || '') + delta.refusal;
      for (const tc of delta.tool_calls || []) {
        const slot = message.tool_calls[tc.index ?? message.tool_calls.length] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }
  if (!out.choices[0].finish_reason) throw new ProviderError('network', 'OpenRouter stream ended before the response finished');
  return out;
}

/**
 * Streamed request. Long reasoning calls can take many minutes before the
 * first token; streaming gets headers immediately and OpenRouter sends
 * keep-alive comments meanwhile, so a dead connection is detected by
 * silence (OPENROUTER_IDLE_TIMEOUT_MS) rather than by a blind total timeout.
 */
async function openrouterFetch(body) {
  const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastByteAt = startedAt;
  let abortReason = null;
  const abortFor = (reason) => { abortReason = reason; controller.abort(); };
  let idle = setTimeout(() => abortFor('idle'), IDLE_TIMEOUT_MS);
  const total = setTimeout(() => abortFor('total'), REQUEST_TIMEOUT_MS);
  const onActivity = () => { lastByteAt = Date.now(); clearTimeout(idle); idle = setTimeout(() => abortFor('idle'), IDLE_TIMEOUT_MS); };
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pastq.app',
        'X-Title': 'PastQ',
      },
      body: JSON.stringify({ ...body, stream: true, usage: { include: true } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      throw new ProviderError(kindForStatus(res.status), `OpenRouter ${res.status}: ${text.slice(0, 500)}`, { status: res.status, body: text, retryAfter });
    }
    let json;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      json = await readStream(res, onActivity);
    } else {
      const text = await res.text();
      try { json = JSON.parse(text); } catch {
        throw new ProviderError('server', `OpenRouter returned a non-JSON body (${res.status})`, { status: res.status, body: text.slice(0, 500) });
      }
      // OpenRouter can report upstream failures inside a 200 response.
      if (json?.error) throw upstreamError(json.error);
    }
    if (!Array.isArray(json?.choices) || !json.choices.length) {
      throw new ProviderError('server', 'OpenRouter returned no choices', { status: res.status, body: json });
    }
    const msg = json.choices[0].message;
    if (msg && Array.isArray(msg.tool_calls) && !msg.tool_calls.length) delete msg.tool_calls;
    return json;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err?.name === 'AbortError') {
      throw new ProviderError('timeout', abortReason === 'idle'
        ? `OpenRouter connection silent for ${IDLE_TIMEOUT_MS}ms`
        : `OpenRouter request exceeded ${REQUEST_TIMEOUT_MS}ms`);
    }
    // Elapsed and silence times show whether drops follow a fixed cutoff or are random.
    throw new ProviderError('network', `OpenRouter network failure: ${err?.cause?.code || err?.message || err} after ${Math.round((Date.now() - startedAt) / 1000)}s (last byte ${Math.round((Date.now() - lastByteAt) / 1000)}s before)`);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

/** Optional reasoning effort (low | medium | high) for speed/quality tuning. */
function reasoningParams() {
  const effort = process.env.VISION_REASONING_EFFORT;
  return effort ? { reasoning: { effort } } : {};
}

function usageOf(res) {
  return {
    promptTokens: res?.usage?.prompt_tokens || 0,
    completionTokens: res?.usage?.completion_tokens || 0,
  };
}

function finishOrThrow(choice, maxTokens, model) {
  if (choice.finish_reason === 'length') {
    throw new ProviderError('truncated', `Model output hit the ${maxTokens}-token limit (model=${model})`);
  }
  if (choice.finish_reason === 'content_filter' || choice.message?.refusal) {
    throw new ProviderError('refused', `Model refused or was filtered: ${choice.message?.refusal || choice.finish_reason}`);
  }
}

function strictParse(text, what) {
  try {
    return JSON.parse(String(text ?? ''));
  } catch (err) {
    throw new ProviderError('invalid_output', `${what} was not valid JSON: ${err.message}`, { body: String(text ?? '').slice(0, 500) });
  }
}

/**
 * Multimodal call with strict JSON-schema output.
 * `messages` is a full OpenAI-style message list (so callers can run repair
 * turns by appending the previous answer and the validation errors).
 */
export async function visionJson({ messages, schema, schemaName, model, maxTokens }) {
  const res = await openrouterFetch({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages,
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    provider: { require_parameters: true },
    ...reasoningParams(),
  });
  const choice = res.choices[0];
  finishOrThrow(choice, maxTokens, model);
  const raw = choice.message?.content ?? '';
  return { data: strictParse(raw, schemaName), raw, usage: usageOf(res), model: res.model || model };
}

/**
 * Tool-calling loop. `handlers[name](args)` returns a string, or
 * { text, imageDataUrl } to feed an image back to the model.
 * `onSubmit(args)` validates the stop tool's arguments: it returns
 * { ok: true, value } to finish, or { ok: false, errors } which are sent back
 * to the model as the tool result so it can correct itself.
 * Throws when the turn budget is exhausted without an accepted submission.
 */
/**
 * Request size per turn: keep the original page (the first user message) and
 * the most recent images; earlier tool images are replaced by a note, since
 * the model can zoom again. Without this every turn re-uploads every image.
 */
function pruneImages(messages) {
  const hasImage = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url');
  const firstUser = messages.findIndex((m) => m.role === 'user');
  let latest = -1;
  messages.forEach((m, i) => { if (hasImage(m) && i !== firstUser) latest = i; });
  return messages.map((m, i) => {
    if (!hasImage(m) || i === firstUser || i === latest) return m;
    return { ...m, content: m.content.map((c) => (c.type === 'image_url' ? { type: 'text', text: '[earlier image omitted — call the tool again to see it]' } : c)) };
  });
}

export async function chatWithTools({ messages, tools, handlers, stopTool, onSubmit, model, maxTurns, maxTokens }) {
  const convo = [...messages];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let lastRejection = null;
  const toolCounts = {};
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await openrouterFetch({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: pruneImages(convo),
      tools,
      // Meta's endpoint accepts only 'auto'; turns without a tool call are
      // answered with an instruction to call one (below).
      tool_choice: 'auto',
      provider: { require_parameters: true },
      ...reasoningParams(),
    });
    const u = usageOf(res);
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    const choice = res.choices[0];
    finishOrThrow(choice, maxTokens, model);
    const calls = choice.message?.tool_calls || [];
    convo.push({ role: 'assistant', content: choice.message?.content || '', tool_calls: calls });
    if (!calls.length) {
      convo.push({ role: 'user', content: `You must call a tool. Inspect with the inspection tools or call ${stopTool}.` });
      continue;
    }
    const images = [];
    for (const call of calls) {
      const name = call.function?.name;
      let args;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (err) {
        convo.push({ role: 'tool', tool_call_id: call.id, content: `Arguments were not valid JSON (${err.message}). Call ${name} again with valid JSON.` });
        continue;
      }
      if (name === stopTool) {
        const verdict = await onSubmit(args);
        if (verdict.ok) return { value: verdict.value, usage, turns: turn + 1, messages: convo };
        lastRejection = verdict.errors?.length ? verdict.errors : [verdict.message];
        const text = verdict.message || `Rejected. Fix every problem and call ${stopTool} again:\n- ${verdict.errors.join('\n- ')}`;
        convo.push({ role: 'tool', tool_call_id: call.id, content: text });
        for (const url of verdict.images || []) images.push({ type: 'image_url', image_url: { url } });
        continue;
      }
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      const handler = handlers[name];
      if (!handler) {
        convo.push({ role: 'tool', tool_call_id: call.id, content: `No tool named ${name}.` });
        continue;
      }
      let out = await handler(args);
      if (out && typeof out === 'object' && out.imageDataUrl) {
        images.push({ type: 'image_url', image_url: { url: out.imageDataUrl } });
        out = out.text;
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: String(out) });
    }
    // Tool messages are text-only on most providers: deliver requested images
    // as a following user message.
    if (images.length) convo.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by your tool calls, in order:' }, ...images] });
  }
  const err = new ProviderError('invalid_output', `No accepted ${stopTool} within ${maxTurns} turns (tool calls: ${JSON.stringify(toolCounts)}; last rejection: ${lastRejection ? lastRejection.slice(0, 8).join(' | ').slice(0, 1200) : 'never submitted'})`);
  err.usage = usage;
  throw err;
}

/** Encode an image buffer as a JPEG data URL with its long side capped at maxSide. */
export async function toDataUrl(buffer, { maxSide, quality = 90 }) {
  const out = await sharp(buffer)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

export { ProviderError, pruneImages };
