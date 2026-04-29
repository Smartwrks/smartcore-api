import express from 'express';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

/**
 * POST /api/rag/query
 *
 * Body: { query: string, topK?: number }
 * Returns: { sources: RagSource[] }
 *
 * Performs a one-shot RAG retrieval: embed the query, search Pinecone,
 * filter low-relevance matches, and normalize metadata into the
 * RagSource shape the frontend expects.
 *
 * Future: read account_provisioning to pick per-account index host,
 * namespace, embedding model, and minimum score threshold. For now
 * uses platform defaults (PINECONE_DEFAULT_INDEX_HOST + no namespace)
 * to preserve parity with existing data.
 */
router.post('/query', async (req, res) => {
  const { query, topK } = req.body || {};

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const top = Number.isInteger(topK) && topK > 0 && topK <= 50 ? topK : 3;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Embedding provider not configured' });
  }
  if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_DEFAULT_INDEX_HOST) {
    return res.status(500).json({ error: 'Vector store not configured' });
  }

  try {
    // 1. Embed the query
    const embedResp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: query,
      }),
    });

    if (!embedResp.ok) {
      const body = await embedResp.text().catch(() => '');
      console.error('[rag/query] embed error:', embedResp.status, body);
      return res.status(502).json({ error: 'Embedding provider error' });
    }

    const embedData = await embedResp.json();
    const vector = embedData?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      return res.status(502).json({ error: 'Unexpected embed response' });
    }

    // 2. Query Pinecone (no namespace — matches existing index layout).
    const pineconeResp = await fetch(`${process.env.PINECONE_DEFAULT_INDEX_HOST}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.PINECONE_API_KEY,
      },
      body: JSON.stringify({
        vector,
        topK: top,
        includeMetadata: true,
      }),
    });

    if (!pineconeResp.ok) {
      const body = await pineconeResp.text().catch(() => '');
      console.error('[rag/query] Pinecone error:', pineconeResp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    const pineconeData = await pineconeResp.json();
    const matches = Array.isArray(pineconeData?.matches) ? pineconeData.matches : [];

    // 3. Normalize Pinecone matches into RagSource shape.
    //    Score threshold 0.15 mirrors the previous frontend filter.
    const sources = matches
      .filter((m) => typeof m.score === 'number' && m.score > 0.15)
      .map((m) => ({
        text: m.metadata?.text ?? m.metadata?.content ?? '',
        source:
          m.metadata?.source_file ??
          m.metadata?.source_url ??
          m.metadata?.url ??
          m.metadata?.title ??
          m.id,
        url: m.metadata?.source_url ?? m.metadata?.url,
        score: m.score,
        documentId: m.metadata?.source_url ?? m.metadata?.url ?? m.id,
        metadata: m.metadata,
      }));

    res.json({ sources });
  } catch (err) {
    console.error('[rag/query] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
