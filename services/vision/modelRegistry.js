/**
 * Live model capabilities and pricing from OpenRouter's /models endpoint.
 *
 * Nothing about the model is assumed: before a session runs, the configured
 * model must prove it accepts images, strict JSON-schema output and tool
 * calls. Pricing and output-token limits come from the same live record.
 */

const CACHE_MS = 60 * 60 * 1000;
let cache = null;

function baseUrl() {
  return process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
}

function configuredModel() {
  const id = String(process.env.VISION_MODEL || 'meta/muse-spark-1.3-contributor').trim();
  if (!id) throw new ModelConfigError('VISION_MODEL is empty');
  return id;
}

class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

async function fetchModels() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  const res = await fetch(`${baseUrl()}/models`);
  if (!res.ok) throw new ModelConfigError(`OpenRouter /models returned ${res.status}`);
  const body = await res.json();
  const models = Array.isArray(body?.data) ? body.data : [];
  cache = { at: Date.now(), models };
  return models;
}

/**
 * Resolve and validate the configured vision model.
 * @returns {{ id, contextLength, maxOutputTokens, price: { input, output } }}
 */
async function resolveVisionModel() {
  const id = configuredModel();
  const record = (await fetchModels()).find((m) => m.id === id);
  if (!record) throw new ModelConfigError(`Model "${id}" is not listed by OpenRouter. Set VISION_MODEL to a listed model id.`);

  const inputs = record.architecture?.input_modalities || [];
  const params = record.supported_parameters || [];
  const missing = [
    inputs.includes('image') ? null : 'image input',
    params.includes('structured_outputs') || params.includes('response_format') ? null : 'structured JSON output',
    params.includes('tools') ? null : 'tool calling',
  ].filter(Boolean);
  if (missing.length) throw new ModelConfigError(`Model "${id}" lacks required capabilities: ${missing.join(', ')}.`);

  const configuredMax = Number(process.env.VISION_MAX_OUTPUT_TOKENS || 0);
  const providerMax = Number(record.top_provider?.max_completion_tokens || 0);
  const maxOutputTokens = [configuredMax, providerMax].filter((n) => n > 0).reduce((a, b) => Math.min(a, b), Infinity);
  if (!Number.isFinite(maxOutputTokens)) {
    throw new ModelConfigError(`Model "${id}" does not publish a max completion size; set VISION_MAX_OUTPUT_TOKENS.`);
  }

  return {
    id,
    contextLength: Number(record.context_length || record.top_provider?.context_length || 0),
    maxOutputTokens,
    price: {
      input: Number(record.pricing?.prompt || 0),
      output: Number(record.pricing?.completion || 0),
    },
  };
}

function costUsd(model, usage) {
  return (usage?.promptTokens || 0) * (model?.price?.input || 0) + (usage?.completionTokens || 0) * (model?.price?.output || 0);
}

function resetModelCache() {
  cache = null;
}

export { resolveVisionModel, costUsd, ModelConfigError, resetModelCache };
