import express from 'express';
import multer from 'multer';
import requireAccountAccess from '../middleware/requireAccountAccess.js';
import requireSuperAdmin from '../middleware/requireSuperAdmin.js';

const router = express.Router();

// 50 MB cap on file uploads — same order of magnitude as a typical PDF catalog.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.use(requireAccountAccess);
router.use(requireSuperAdmin);

const SMARTCRAWLER_URL = () => process.env.SMARTCRAWLER_URL;
const PINECONE_INDEX_NAME = () => process.env.PINECONE_INDEX_NAME;

function ensureConfigured(res) {
  if (!SMARTCRAWLER_URL() || !PINECONE_INDEX_NAME()) {
    res.status(500).json({ error: 'Ingestion pipeline not configured' });
    return false;
  }
  return true;
}

// Maps the UI's depth selector to SmartCrawler's max_depth + max_pages knobs.
// Mirrors the openai-vector-test mapping so behavior is consistent.
const DEPTH_LIMITS = {
  '1':   { max_depth: 1, max_pages: 1 },
  '2':   { max_depth: 2, max_pages: 20 },
  '3':   { max_depth: 3, max_pages: 50 },
  'all': { max_depth: 5, max_pages: 1000 },
};

/**
 * POST /api/admin/ingest/url
 * Body: { url, depth?, includePdfs?, renderJs? }
 * Returns: { taskId }
 *
 * Forces namespace = req.account.id and pinecone_index from server env so
 * a caller cannot crawl into another account's namespace or a different
 * index by tampering with the request.
 */
router.post('/url', async (req, res) => {
  if (!ensureConfigured(res)) return;

  const { url, depth = '2', includePdfs = false, renderJs = false } = req.body || {};
  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const { max_depth, max_pages } = DEPTH_LIMITS[String(depth)] || DEPTH_LIMITS['2'];

  try {
    const resp = await fetch(`${SMARTCRAWLER_URL()}/api/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        max_depth,
        max_pages,
        ingest_pdfs: !!includePdfs,
        render_js: !!renderJs,
        embedding_provider: 'openai',
        pinecone_index: PINECONE_INDEX_NAME(),
        namespace: req.account.id,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[ingest/url] SmartCrawler error:', resp.status, body);
      return res.status(502).json({ error: 'Crawler service error' });
    }

    const data = await resp.json();
    res.json({ taskId: data.task_id });
  } catch (err) {
    console.error('[ingest/url] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/ingest/document
 * Multipart upload (field name: file).
 * Returns: { taskId }
 */
router.post('/document', upload.single('file'), async (req, res) => {
  if (!ensureConfigured(res)) return;
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  try {
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], {
      type: req.file.mimetype || 'application/octet-stream',
    });
    formData.append('file', blob, req.file.originalname);
    formData.append('embedding_provider', 'openai');
    formData.append('pinecone_index', PINECONE_INDEX_NAME());
    formData.append('namespace', req.account.id);

    const resp = await fetch(`${SMARTCRAWLER_URL()}/api/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[ingest/document] SmartCrawler error:', resp.status, body);
      return res.status(502).json({ error: 'Upload service error' });
    }

    const data = await resp.json();
    res.json({ taskId: data.task_id });
  } catch (err) {
    console.error('[ingest/document] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/ingest/url/:taskId/status
 * GET /api/admin/ingest/document/:taskId/status
 *
 * SSE proxy. The browser doesn't see SmartCrawler's URL — it streams
 * status events through smartcore-api so JWT auth still applies.
 */
router.get('/url/:taskId/status', (req, res) =>
  proxyTaskStatus(res, `${SMARTCRAWLER_URL()}/api/crawl/${encodeURIComponent(req.params.taskId)}/status`),
);

router.get('/document/:taskId/status', (req, res) =>
  proxyTaskStatus(res, `${SMARTCRAWLER_URL()}/api/upload/${encodeURIComponent(req.params.taskId)}/status`),
);

async function proxyTaskStatus(res, upstreamUrl) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl);
  } catch (err) {
    console.error('[ingest/status] upstream unreachable:', err);
    return res.status(502).json({ error: 'Crawler unreachable' });
  }

  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'Status stream unavailable' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientGone) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    if (!clientGone) console.error('[ingest/status] stream error:', err);
  } finally {
    res.end();
  }
}

export default router;
