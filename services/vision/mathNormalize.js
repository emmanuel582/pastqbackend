/**
 * Convert spoken / OCR math phrasing into inline LaTeX ($...$) for CBT rendering.
 * Safe to run multiple times; leaves existing $...$ / $$...$$ blocks alone.
 */

function protectMath(text) {
  const blocks = [];
  const protectedText = String(text || '').replace(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g, (m) => {
    const i = blocks.length;
    blocks.push(m);
    return `\u0000MATH${i}\u0000`;
  });
  return { protectedText, blocks };
}

function restoreMath(text, blocks) {
  return String(text || '').replace(/\u0000MATH(\d+)\u0000/g, (_, i) => blocks[Number(i)] || '');
}

function normalizeSpokenMath(raw) {
  let s = String(raw || '');
  if (!s.trim()) return s;

  const { protectedText, blocks } = protectMath(s);
  s = protectedText;

  // 2 raise 2 / 2 raised to 2 / 2 raised to the power of 2 / x raise y
  s = s.replace(
    /\b(\d+(?:\.\d+)?|[A-Za-z])\s*(?:raise(?:d)?(?:\s+to(?:\s+the(?:\s+power(?:\s+of)?)?)?)?)\s+(\d+(?:\.\d+)?|[A-Za-z])\b/gi,
    (_, base, exp) => `$${base}^{${exp}}$`
  );

  // x squared / y cubed
  s = s.replace(/\b(\d+(?:\.\d+)?|[A-Za-z])\s+squared\b/gi, (_, b) => `$${b}^2$`);
  s = s.replace(/\b(\d+(?:\.\d+)?|[A-Za-z])\s+cubed\b/gi, (_, b) => `$${b}^3$`);

  // square root of …
  s = s.replace(
    /square\s+roots?\s+of\s*\(?\s*([A-Za-z0-9+\-*/^=_\\{}]+(?:\s+[A-Za-z0-9+\-*/^=_\\{}]+){0,6})\s*\)?/gi,
    (_, x) => `$\\sqrt{${String(x).trim()}}$`
  );

  // cube root of …
  s = s.replace(
    /cube\s+roots?\s+of\s*\(?\s*([A-Za-z0-9+\-*/^=_\\{}]+(?:\s+[A-Za-z0-9+\-*/^=_\\{}]+){0,6})\s*\)?/gi,
    (_, x) => `$\\sqrt[3]{${String(x).trim()}}$`
  );

  // fraction a over b
  s = s.replace(
    /\bfraction\s+([^,\n]{1,30}?)\s+over\s+([^,\n.]{1,30}?)(?=[,.;)\s]|$)/gi,
    (_, a, b) => `$\\frac{${String(a).trim()}}{${String(b).trim()}}$`
  );

  // a over b (simple ASCII fraction spoken form) — only small tokens
  s = s.replace(
    /\b(\d+(?:\.\d+)?|[A-Za-z])\s+over\s+(\d+(?:\.\d+)?|[A-Za-z])\b/gi,
    (_, a, b) => `$\\frac{${a}}{${b}}$`
  );

  // x to the power of n
  s = s.replace(
    /\b(\d+(?:\.\d+)?|[A-Za-z])\s+to\s+the\s+power\s+of\s+(\d+(?:\.\d+)?|[A-Za-z])\b/gi,
    (_, base, exp) => `$${base}^{${exp}}$`
  );

  return restoreMath(s, blocks);
}

function normalizeQuestionMath(q) {
  if (!q || typeof q !== 'object') return q;
  if (typeof q.question === 'string') q.question = normalizeSpokenMath(q.question);
  if (Array.isArray(q.options)) {
    q.options = q.options.map((o) => (typeof o === 'string' ? normalizeSpokenMath(o) : o));
  }
  if (typeof q.explanation === 'string') q.explanation = normalizeSpokenMath(q.explanation);
  return q;
}

export { normalizeSpokenMath, normalizeQuestionMath };
