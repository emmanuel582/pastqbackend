import crypto from 'crypto';

const WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const DEFAULT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const UPLOAD_MAX = Number.parseInt(process.env.RATE_LIMIT_UPLOAD_MAX || '20', 10);
const buckets = new Map();

function identity(req) {
  return req.auth?.user?.id || req.ip || 'anonymous';
}

function take(key, limit) {
  const now = Date.now();
  // Expire abandoned IP/user buckets so public endpoints cannot grow memory forever.
  if (buckets.size >= 10000) {
    for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
    if (buckets.size >= 10000 && !buckets.has(key)) return { allowed: false, remaining: 0, resetAt: now + WINDOW_MS };
  }
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + WINDOW_MS };
  }
  current.count += 1;
  return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count), resetAt: current.resetAt };
}

/** In-memory protection for a single Hostinger VPS process. Move this state to Redis before multi-instance deployment. */
export function rateLimit({ limit = DEFAULT_MAX, keyPrefix = 'api' } = {}) {
  return (req, res, next) => {
    const result = take(`${keyPrefix}:${identity(req)}`, limit);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(result.remaining));
    res.set('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } });
    }
    return next();
  };
}

export const uploadRateLimit = rateLimit({ limit: UPLOAD_MAX, keyPrefix: 'upload' });

export function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
  return next();
}

export function requestContext(req, res, next) {
  const headerId = req.get('x-request-id');
  req.requestId = headerId && /^[a-zA-Z0-9_-]{8,128}$/.test(headerId) ? headerId : crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  return next();
}
