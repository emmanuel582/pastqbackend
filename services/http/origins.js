/**
 * Browser origins allowed by CORS, from a comma-separated list such as
 * FRONTEND_URL. An entry may use "*" for one hostname label
 * (https://pastq-*.vercel.app for Vercel preview deployments); "*" never
 * matches a dot, so it cannot stand in for another domain.
 */
export function createOriginMatcher(list = '') {
  const entries = String(list).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const exact = new Set(entries.filter((o) => !o.includes('*')));
  const patterns = entries
    .filter((o) => o !== '*' && o.includes('*'))
    .map((o) => new RegExp(`^${o.split('*').map(escapeRegExp).join('[a-z0-9-]+')}$`, 'i'));
  return {
    configured: entries.length > 0,
    allowsAny: entries.includes('*'),
    allows: (origin) => exact.has(origin) || patterns.some((re) => re.test(origin)),
  };
}

function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
