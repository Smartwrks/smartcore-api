import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';

import healthRoutes from './routes/health.js';
import accountRoutes from './routes/account.js';
import embeddingsRoutes from './routes/embeddings.js';
import ragRoutes from './routes/rag.js';
import chatHistoryRoutes from './routes/chatHistory.js';
import chatRoutes from './routes/chat.js';
import chatSessionsRoutes from './routes/chatSessions.js';
import remindersRoutes from './routes/reminders.js';
import templatesRoutes from './routes/templates.js';
import uploadedDocumentsRoutes from './routes/uploadedDocuments.js';
import profileRoutes from './routes/profile.js';
import adminUsersRoutes from './routes/adminUsers.js';
import adminPineconeRoutes from './routes/adminPinecone.js';
import adminIngestRoutes from './routes/adminIngest.js';

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Supabase clients ───────────────────────────────────────────────────────
// Secret-key client bypasses RLS — used for all data reads/writes once the
// caller's account scope has been established by middleware.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

// Publishable-key client is used SOLELY to verify caller JWTs in middleware.
// We don't query data through it.
export const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY,
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
app.use('/api/embeddings', embeddingsRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/chat-history', chatHistoryRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/chat-sessions', chatSessionsRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/uploaded-documents', uploadedDocumentsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/admin/pinecone', adminPineconeRoutes);
app.use('/api/admin/ingest', adminIngestRoutes);

// Future routes will mount here:
// app.use('/api/platform', platformRoutes);

app.listen(PORT, () => {
  console.log(`smartcore-api listening on :${PORT}`);
});
