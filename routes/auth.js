import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { rateLimit } from '../services/http/security.js';
import { authInput } from '../services/auth/validation.js';

const router = express.Router();
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const serverKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_ROLE_KEY || supabaseAnonKey;
const isConfigured = Boolean(supabaseUrl && supabaseAnonKey && serverKey);

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const supabase = isConfigured ? createClient(supabaseUrl, serverKey, clientOptions) : null;
// Auth sessions must never be shared between concurrent HTTP requests.
const authClient = () => createClient(supabaseUrl, supabaseAnonKey, clientOptions);
router.use(rateLimit({ limit: 12, keyPrefix: 'auth' }));
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function validatedInput(req, res, signup = false) {
  try { return authInput(req.body, { signup }); }
  catch (error) { res.status(400).json({ error: error.message }); return null; }
}

function requireConfiguredSupabase(res) {
  if (isConfigured) return true;
  res.status(503).json({ error: 'Authentication is not configured on this server.' });
  return false;
}

router.post('/signup', async (req, res) => {
  try {
    if (!requireConfiguredSupabase(res)) return;
    const input = validatedInput(req, res, true);
    if (!input) return;
    const { email, password, name } = input;

    const { data, error } = await authClient().auth.signUp({
      email,
      password,
      options: { data: { full_name: name } },
    });
    if (error) return res.status(400).json({ error: error.message });

    // A service role is optional. With only the publishable key, the client
    // creates its own RLS-protected profile after a confirmed login.
    if (data.user && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const { error: dbError } = await supabase.from('users').upsert({
        id: data.user.id,
        full_name: name,
        email: data.user.email,
        onboarding_complete: false,
      });
      if (dbError) console.error('[auth] profile creation failed:', dbError.message);
    }
    return res.json({ user: data.user, session: data.session });
  } catch (error) {
    console.error('[auth] signup failed:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    if (!requireConfiguredSupabase(res)) return;
    const input = validatedInput(req, res);
    if (!input) return;
    const { data, error } = await authClient().auth.signInWithPassword(input);
    if (error) return res.status(400).json({ error: 'Email or password is incorrect.' });
    return res.json({ user: data.user, session: data.session });
  } catch (error) {
    console.error('[auth] login failed:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    if (!requireConfiguredSupabase(res)) return;
    // The browser owns its Supabase access token. This endpoint remains
    // compatible with the client but does not attempt a global server logout.
    return res.json({ success: true });
  } catch (error) {
    console.error('[auth] logout failed:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
