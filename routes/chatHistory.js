import express from 'express';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

const PINECONE_HOST = () => process.env.PINECONE_INDEX_HOST;

async function embedText(text) {
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
 * POST /api/chat-history/index
 *
 * Body: { messageId, content, sessionId, role, sessionTitle? }
 *
 * Embeds the message and upserts to Pinecone with user_id taken from
 * the verified JWT (not trusting the client to pass it correctly).
 * Best-effort: returns 200 on no-op for short messages so the caller
 * can fire-and-forget without retry logic.
 */
router.post('/index', async (req, res) => {
  const { messageId, content, sessionId, role, sessionTitle } = req.body || {};

  if (typeof messageId !== 'string' || !messageId) {
    return res.status(400).json({ error: 'messageId is required' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  if (role !== 'user' && role !== 'assistant') {
    return res.status(400).json({ error: 'role must be user or assistant' });
  }

  // Skip very short messages — not worth indexing.
  if (content.trim().length < 10) {
    return res.json({ ok: true, indexed: false, reason: 'too short' });
  }

  if (!process.env.OPENAI_API_KEY || !process.env.PINECONE_API_KEY || !PINECONE_HOST()) {
    return res.status(500).json({ error: 'Indexing pipeline not configured' });
  }

  try {
    const vector = await embedText(content);

    const upsertResp = await fetch(`${PINECONE_HOST()}/vectors/upsert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.PINECONE_API_KEY,
      },
      body: JSON.stringify({
        namespace: req.account.id,
        vectors: [
          {
            id: `chat-${messageId}`,
            values: vector,
            metadata: {
              type: 'chat_message',
              user_id: req.user.id,
              session_id: sessionId,
              role,
              timestamp: new Date().toISOString(),
              text: content.substring(0, 1000),
              session_title: sessionTitle || '',
            },
          },
        ],
      }),
    });

    if (!upsertResp.ok) {
      const body = await upsertResp.text().catch(() => '');
      console.error('[chat-history/index] Pinecone error:', upsertResp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    res.json({ ok: true, indexed: true });
  } catch (err) {
    console.error('[chat-history/index] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/chat-history/query
 *
 * Body: { query: string, topK?: number, startDate?: ISO, endDate?: ISO }
 * Returns: { results: ChatHistoryResult[] }
 *
 * user_id filter is taken from the verified JWT — caller cannot query
 * another user's history.
 */
router.post('/query', async (req, res) => {
  const { query, topK, startDate, endDate } = req.body || {};

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const top = Number.isInteger(topK) && topK > 0 && topK <= 50 ? topK : 5;

  if (!process.env.OPENAI_API_KEY || !process.env.PINECONE_API_KEY || !PINECONE_HOST()) {
    return res.status(500).json({ error: 'Query pipeline not configured' });
  }

  try {
    const vector = await embedText(query);

    const filter = {
      type: { $eq: 'chat_message' },
      user_id: { $eq: req.user.id },
    };
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = String(startDate);
      if (endDate) filter.timestamp.$lte = String(endDate);
    }

    const queryResp = await fetch(`${PINECONE_HOST()}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.PINECONE_API_KEY,
      },
      body: JSON.stringify({
        vector,
        topK: top,
        includeMetadata: true,
        filter,
        namespace: req.account.id,
      }),
    });

    if (!queryResp.ok) {
      const body = await queryResp.text().catch(() => '');
      console.error('[chat-history/query] Pinecone error:', queryResp.status, body);
      return res.status(502).json({ error: 'Vector store error' });
    }

    const data = await queryResp.json();
    const matches = Array.isArray(data?.matches) ? data.matches : [];

    // 0.3 threshold mirrors the previous frontend filter.
    const results = matches
      .filter((m) => typeof m.score === 'number' && m.score > 0.3)
      .map((m) => ({
        id: m.id,
        score: m.score,
        text: m.metadata?.text || '',
        role: m.metadata?.role || 'user',
        timestamp: m.metadata?.timestamp || '',
        sessionId: m.metadata?.session_id || '',
        sessionTitle: m.metadata?.session_title || '',
      }));

    res.json({ results });
  } catch (err) {
    console.error('[chat-history/query] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
