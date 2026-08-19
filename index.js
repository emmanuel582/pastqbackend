import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import visionRoutes from './routes/vision.js';
import { PROVIDER, MODELS } from './services/vision/models.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser tools and same-origin requests
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes('*')) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Vercel production + preview deployments
    if (/\.vercel\.app$/i.test(origin)) return callback(null, true);
    // Local development
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
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
app.use('/api/vision', visionRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message || err);
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PastQ backend listening on 0.0.0.0:${PORT}`);
  console.log(`[vision] provider=${PROVIDER} ocr=${MODELS.ocr} cheap=${MODELS.cheap} strong=${MODELS.strong}`);
});
