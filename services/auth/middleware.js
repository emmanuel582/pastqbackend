import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const localBypass = process.env.AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT === 'true' && process.env.NODE_ENV !== 'production';
const ownerSecret = process.env.SESSION_OWNER_HMAC_SECRET || (process.env.NODE_ENV !== 'production' ? 'pastq-local-owner-secret' : '');
const configuredAdminIds = new Set(
  (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const authClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function unauthorized(res, message = 'Authentication required') {
  return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message } });
}

function forbidden(res, message = 'You do not have permission to perform this action') {
  return res.status(403).json({ error: { code: 'FORBIDDEN', message } });
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function userIsAdmin(user) {
  if (!user) return false;
  if (configuredAdminIds.has(user.id)) return true;
  const appRoles = user.app_metadata?.roles || [];
  return user.app_metadata?.role === 'admin' || appRoles.includes('admin');
}

function sessionOwnerKey(userId) {
  if (!ownerSecret) return null;
  return crypto.createHmac('sha256', ownerSecret).update(userId).digest('base64url');
}

/**
 * Verifies a Supabase access token and places the trusted user on req.auth.
 * The only bypass is an explicit non-production local-development switch.
 */
export async function requireAuthenticatedUser(req, res, next) {
  if (localBypass) {
    req.auth = {
      user: { id: 'local-development-user', email: 'local@pastq.test' },
      isAdmin: true,
      ownerKey: sessionOwnerKey('local-development-user'),
    };
    return next();
  }

  if (!authClient) {
    return res.status(503).json({
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: 'The server authentication provider is not configured.',
      },
    });
  }
  if (!ownerSecret) {
    return res.status(503).json({
      error: { code: 'OWNER_KEY_NOT_CONFIGURED', message: 'The server ownership key is not configured.' },
    });
  }

  const token = bearerToken(req);
  if (!token) return unauthorized(res);

  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return unauthorized(res, 'Your session is invalid or has expired');
    req.auth = { user: data.user, isAdmin: userIsAdmin(data.user), ownerKey: sessionOwnerKey(data.user.id) };
    return next();
  } catch (error) {
    console.error('[auth] token verification failed:', error.message);
    return unauthorized(res, 'Unable to verify your session');
  }
}

export function requireAdmin(req, res, next) {
  if (!req.auth?.isAdmin) return forbidden(res);
  return next();
}

export function ownsSession(req, session) {
  return Boolean(session && req.auth && (req.auth.isAdmin || session.ownerKey === req.auth.ownerKey));
}

export function requireOwnedSession(req, res, next) {
  const session = req.pastqSession;
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
  if (!ownsSession(req, session)) return forbidden(res, 'You do not have access to this session');
  return next();
}
