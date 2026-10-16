/**
 * Structural check of a model output against the JSON schema it was asked for.
 *
 * Providers do not all enforce strict schemas (tool arguments in particular),
 * so every output is checked here before any contract logic touches it.
 * Problems are returned as readable messages for a repair turn — nothing is
 * coerced or defaulted. Supports the subset of JSON Schema the pipeline uses:
 * type (single or list), enum, required, properties, additionalProperties,
 * items.
 */

const MAX_PROBLEMS = 40;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function walk(schema, value, path, out) {
  if (out.length >= MAX_PROBLEMS) return;
  const types = schema.type == null ? null : [].concat(schema.type);
  if (types && !types.some((t) => matchesType(value, t))) {
    out.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    return;
  }
  if (typeOf(value) === 'object' && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) out.push(`${path}.${key}: is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in schema.properties)) out.push(`${path}.${key}: is not an allowed field`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) walk(sub, value[key], `${path}.${key}`, out);
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, out));
  }
}

function schemaProblems(schema, value, path = 'result') {
  const out = [];
  walk(schema, value, path, out);
  return out;
}

export { schemaProblems };
