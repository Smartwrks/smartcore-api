import express from 'express';
import requireAccountAccess from '../middleware/requireAccountAccess.js';
import requireAccountAdmin from '../middleware/requireAccountAdmin.js';

const router = express.Router();

router.use(requireAccountAccess);
router.use(requireAccountAdmin);

const PINECONE_HOST = () => process.env.PINECONE_HOST_DEFAULT;

function ensureConfigured(res) {
  if (!process.env.PINECONE_API_KEY || !PINECONE_HOST()) {
    res.status(500).json({ error: 'Vector store not configured' });
    return false;
  }
  return true;
}

async function pineconeFetch(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Api-Key', process.env.PINECONE_API_KEY);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${PINECONE_HOST()}${path}`, { ...init, headers });
}

async function embedText(text) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`embed failed: ${resp.status} ${body}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('embed: unexpected provider response');
  return vector;
}

/**
 * GET /api/admin/pinecone/stats
 * Returns: { totalVectors, dimensions, indexFullness, namespaces }
 */
router.get('/stats', async (req, res) => {
  if (!ensureConfigured(res)) return;

  try {
    const resp = await pineconeFetch('/describe_index_stats', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[admin/pinecone/stats] error:', resp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    const data = await resp.json();
    res.json({
      totalVectors: data.totalVectorCount || 0,
      dimensions: data.dimension || 0,
      indexFullness: data.indexFullness || 0,
      namespaces: data.namespaces || {},
    });
  } catch (err) {
    console.error('[admin/pinecone/stats] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/pinecone/search
 * Body: { keyword, limit? }
 * Returns: { vectors: VectorRecord[], total }
 *
 * Embeds the keyword server-side, queries Pinecone, returns matches.
 */
router.post('/search', async (req, res) => {
  if (!ensureConfigured(res)) return;

  const { keyword, limit } = req.body || {};
  if (typeof keyword !== 'string' || !keyword.trim()) {
    return res.status(400).json({ error: 'keyword is required' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Embedding provider not configured' });
  }

  const top = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 50;

  try {
    const vector = await embedText(keyword);

    const resp = await pineconeFetch('/query', {
      method: 'POST',
      body: JSON.stringify({ vector, topK: top, includeMetadata: true }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[admin/pinecone/search] error:', resp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    const data = await resp.json();
    const vectors = (Array.isArray(data?.matches) ? data.matches : []).map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata || {},
      values: m.values,
    }));
    res.json({ vectors, total: vectors.length });
  } catch (err) {
    console.error('[admin/pinecone/search] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/pinecone/recent?limit=N
 * Returns: { vectors: VectorRecord[], total }
 *
 * Pinecone has no native list-all; we issue a query with a small non-zero
 * vector to pull arbitrary results. Best-effort browse for the admin UI.
 */
router.get('/recent', async (req, res) => {
  if (!ensureConfigured(res)) return;

  const limitParam = parseInt(String(req.query.limit ?? ''), 10);
  const top =
    Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 1000
      ? limitParam
      : 50;

  try {
    // Step 1: get dimensions from index stats.
    const statsResp = await pineconeFetch('/describe_index_stats', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!statsResp.ok) {
      return res.status(502).json({ error: 'Vector store error (stats)' });
    }
    const stats = await statsResp.json();
    const dimensions = stats.dimension || 0;
    if (dimensions === 0) {
      return res.json({ vectors: [], total: 0 });
    }

    // Step 2: query with a small non-zero vector (Pinecone rejects all-zero).
    const dummy = new Array(dimensions).fill(0.001);
    const resp = await pineconeFetch('/query', {
      method: 'POST',
      body: JSON.stringify({ vector: dummy, topK: top, includeMetadata: true }),
    });
    if (!resp.ok) {
      return res.status(502).json({ error: 'Vector store error (query)' });
    }
    const data = await resp.json();
    const vectors = (Array.isArray(data?.matches) ? data.matches : []).map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata || {},
      values: m.values,
    }));
    res.json({ vectors, total: vectors.length });
  } catch (err) {
    console.error('[admin/pinecone/recent] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/pinecone/update
 * Body: { id, metadata }
 */
router.post('/update', async (req, res) => {
  if (!ensureConfigured(res)) return;

  const { id, metadata } = req.body || {};
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!metadata || typeof metadata !== 'object') {
    return res.status(400).json({ error: 'metadata object is required' });
  }

  try {
    const resp = await pineconeFetch('/vectors/update', {
      method: 'POST',
      body: JSON.stringify({ id, setMetadata: metadata }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[admin/pinecone/update] error:', resp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/pinecone/update] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/pinecone/delete
 * Body: { ids: string[] }
 */
router.post('/delete', async (req, res) => {
  if (!ensureConfigured(res)) return;

  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  try {
    const resp = await pineconeFetch('/vectors/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[admin/pinecone/delete] error:', resp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/pinecone/delete] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
