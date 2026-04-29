import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';

import healthRoutes from './routes/health.js';
import accountRoutes from './routes/account.js';

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Supabase clients ───────────────────────────────────────────────────────
// Service-role client bypasses RLS — used for all data reads/writes once the
// caller's account scope has been established by middleware.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// Anon-key client is used SOLELY to verify caller JWTs in middleware.
// We don't query data through it.
export const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

// ─── Trust proxy (Railway terminates TLS) ───────────────────────────────────
app.set('trust proxy', 1);

// ─── Security headers ───────────────────────────────────────────────────────
// Default helmet — the SmartCore frontend talks to us from a known origin
// list (no public widget like smartvue), so we don't need to relax CORP.
app.use(helmet());

// ─── CORS ───────────────────────────────────────────────────────────────────
// Auth is carried via Authorization Bearer headers, not cookies, so a
// permissive-but-explicit origin list is the right control here.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl
    if (allowedOrigins.length === 0) return cb(null, true); // dev: no whitelist set
    cb(null, allowedOrigins.includes(origin));
  },
  credentials: false,
}));

// ─── Body parsing ───────────────────────────────────────────────────────────
// 1MB cap covers attached-file payloads from chat without inviting abuse.
app.use(express.json({ limit: '1mb' }));

// ─── Global rate limit ──────────────────────────────────────────────────────
// 300 req/min per IP. Per-account limits are stricter and applied in
// middleware once the caller's account is known.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/', healthRoutes);
app.use('/api/account', accountRoutes);

// Future routes (Phase 3+) will mount here:
// app.use('/api/chat', chatRoutes);
// app.use('/api/rag', ragRoutes);
// app.use('/api/pinecone', pineconeAdminRoutes);
// app.use('/api/platform', platformRoutes);

app.listen(PORT, () => {
  console.log(`smartcore-api listening on :${PORT}`);
});
