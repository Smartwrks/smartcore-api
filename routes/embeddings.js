import express from 'express';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

/**
 * POST /api/embeddings
 *
 * Body: { text: string }
 * Returns: { vector: number[] }
 *
 * Generates an embedding using OpenAI text-embedding-3-small (1536 dims)
 * — matches the model the existing Pinecone index was indexed with.
 *
 * Future: read account_provisioning.embedding_provider/model and route
 * per-account. For now hardcoded to keep parity with existing data.
 */
router.post('/', async (req, res) => {
  const { text } = req.body || {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('[embeddings] OPENAI_API_KEY not set');
    return res.status(500).json({ error: 'Embedding provider not configured' });
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[embeddings] OpenAI error:', resp.status, body);
      return res.status(502).json({ error: 'Embedding provider error' });
    }

    const data = await resp.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      console.error('[embeddings] unexpected response shape:', data);
      return res.status(502).json({ error: 'Unexpected provider response' });
    }

    res.json({ vector });
  } catch (err) {
    console.error('[embeddings] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
