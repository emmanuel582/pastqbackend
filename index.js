import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import visionRoutes from './routes/vision.js';
import { resumeInterruptedSessions } from './services/vision/processor.js';
import libraryRoutes from './routes/library.js';
import { installLibrarySeeds } from './services/library/seeds.js';
import recommendationRoutes from './routes/recommendations.js';
import reminderRoutes from './routes/reminders.js';
import discoverRoutes from './routes/discover.js';
import { startReminderScheduler } from './services/reminders/delivery.js';
import fs from 'fs';
import { getDataRoot } from './services/vision/store.js';
import { requestContext, securityHeaders } from './services/http/security.js';
import { openRouterKeyFingerprint } from './services/vision/openrouterProvider.js';
import { createOriginMatcher } from './services/http/origins.js';

const app = express();
const PORT = process.env.PORT || 3000;
const listenAddress = process.env.PASTQ_BIND_ADDRESS || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

app.set('trust proxy', 1);
app.use(requestContext);
app.use(securityHeaders);

const origins = createOriginMatcher(process.env.FRONTEND_URL);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser tools and same-origin requests
    if (!origin) return callback(null, true);
    // A production browser origin must be intentionally configured. This keeps
    // a new Hostinger deployment from becoming a public cross-origin API.
    if (!origins.configured && process.env.NODE_ENV === 'production') {
      console.warn('[cors] FRONTEND_URL is not configured; blocking browser origin');
      return callback(null, false);
    }
    if (!origins.configured || (origins.allowsAny && process.env.NODE_ENV !== 'production') || origins.allows(origin)) return callback(null, true);
    // Local development
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return callback(null, true);
    }
    // Reject without throwing — throwing strips CORS headers and looks like a browser CORS failure
    console.warn(`[cors] blocked origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use((req, res, next) => {
  const limit = req.path.startsWith('/api/auth/') || req.path.startsWith('/api/discover') ? '16kb' : req.path.startsWith('/api/reminders') ? '64kb' : '20mb';
  express.json({ limit })(req, res, next);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.requestId} ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/', (_req, res) => {
  res.json({
    service: 'pastq-backend',
    status: 'ok',
    health: '/api/health',
  });
});

app.use('/api/auth', authRoutes);

// Give upload routes extra time — mobile bulk-uploads can be large
app.use('/api/vision', (req, _res, next) => {
  req.setTimeout(5 * 60 * 1000); // 5 minutes
  next();
});
app.use('/api/vision', visionRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/discover', discoverRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

if (process.env.NODE_ENV !== 'production') {
  const { default: devMonitorRoutes } = await import('./routes/devMonitor.js');
  app.use('/debug', devMonitorRoutes);
  console.log('[dev] live monitor mounted at /debug/session/:id (local only, not mounted in production)');
}

app.get('/api/health/ready', (_req, res) => {
  const authConfigured = (
    Boolean(
      (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) &&
      (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY)
    ) && Boolean(process.env.SESSION_OWNER_HMAC_SECRET)
  ) || (process.env.AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT === 'true' && process.env.NODE_ENV !== 'production');
  let storageWritable = true;
  try {
    fs.accessSync(getDataRoot(), fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    storageWritable = false;
  }
  const ready = authConfigured && storageWritable;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: { authentication: authConfigured, hostingerStorage: storageWritable },
  });
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'This upload is too large. Choose a smaller file.' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid request body.' });
  console.error('Unhandled error:', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

installLibrarySeeds();

app.listen(PORT, listenAddress, () => {
  console.log(`PastQ backend listening on ${listenAddress}:${PORT}`);
  // Continue any extraction that was interrupted by a restart or crash.
  resumeInterruptedSessions();
  startReminderScheduler();
  console.log(`[vision] model=${process.env.VISION_MODEL || 'meta/muse-spark-1.3-contributor'} (capabilities checked per session)`);
  console.log(`[vision] OPENROUTER_API_KEY=${openRouterKeyFingerprint()}`);

  if (process.env.LIBRARY_SYNC_SUPABASE === 'true') {
    console.warn('[storage] LIBRARY_SYNC_SUPABASE is ignored: question content is Hostinger-only.');
  }
});
