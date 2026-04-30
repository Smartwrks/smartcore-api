import express from 'express';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * POST /api/chat/completions
 *
 * Body mirrors OpenAI's /v1/chat/completions shape:
 *   {
 *     messages: [{ role, content }],
 *     model?, temperature?, max_tokens?, stream?, tools?
 *   }
 *
 * Streaming: server pipes OpenAI's SSE response straight to the client.
 * Non-streaming: returns OpenAI's JSON response unchanged.
 *
 * Future: validate model against account_provisioning.llm_allowed_models;
 * route to Google/Anthropic per llm_provider. For now uses OpenAI directly
 * with a hardcoded default model.
 */
router.post('/completions', async (req, res) => {
  const { messages, model, temperature, max_tokens, stream, tools } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'LLM provider not configured' });
  }

  const openaiBody = {
    model: typeof model === 'string' && model ? model : DEFAULT_MODEL,
    messages,
    stream: stream === true,
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof max_tokens === 'number' && max_tokens > 0 ? { max_tokens } : {}),
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
  };

  let upstream;
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiBody),
    });
  } catch (err) {
    console.error('[chat/completions] fetch failed:', err);
    return res.status(502).json({ error: 'LLM provider unreachable' });
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    console.error('[chat/completions] upstream error:', upstream.status, body);
    // Forward the status so the client can distinguish 429 vs 5xx.
    return res.status(upstream.status === 429 ? 429 : 502).json({
      error: 'LLM provider error',
      status: upstream.status,
    });
  }

  // Non-streaming: forward the JSON.
  if (!openaiBody.stream) {
    const data = await upstream.json();
    return res.json(data);
  }

  // Streaming: pipe the SSE response through.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/proxy buffering if any.
  res.flushHeaders();

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    console.error('[chat/completions] stream error:', err);
  } finally {
    res.end();
  }
});

export default router;
