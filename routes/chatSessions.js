import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

const SESSION_COLUMNS = 'id, user_id, account_id, title, created_at, updated_at';
const MESSAGE_COLUMNS = 'id, session_id, role, content, sources, user_feedback, feedback_timestamp, confidence, created_at';

function deriveTitle(firstMessage) {
  if (typeof firstMessage !== 'string') return 'New chat';
  const trimmed = firstMessage.trim();
  if (!trimmed) return 'New chat';
  return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
}

// Verify the session belongs to the caller. Returns the session row or null.
async function getOwnedSession(sessionId, userId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** POST /api/chat-sessions — create a new session for the caller. */
router.post('/', async (req, res) => {
  const { firstMessage } = req.body || {};
  const title = deriveTitle(firstMessage);

  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({
        user_id: req.user.id,
        account_id: req.account.id,
        title,
      })
      .select(SESSION_COLUMNS)
      .single();

    if (error) {
      console.error('[chat-sessions POST] error:', error);
      return res.status(500).json({ error: 'Failed to create session' });
    }

    res.json({ session: data });
  } catch (err) {
    console.error('[chat-sessions POST] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/chat-sessions — list caller's sessions, newest first. */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select(SESSION_COLUMNS)
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[chat-sessions GET] error:', error);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }

    res.json({ sessions: data ?? [] });
  } catch (err) {
    console.error('[chat-sessions GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/chat-sessions/:id — fetch one session. */
router.get('/:id', async (req, res) => {
  try {
    const session = await getOwnedSession(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  } catch (err) {
    console.error('[chat-sessions GET :id] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/chat-sessions/:id — update title. */
router.patch('/:id', async (req, res) => {
  const updates = {};
  if (typeof req.body?.title === 'string') {
    const t = req.body.title.trim();
    if (!t) return res.status(400).json({ error: 'title cannot be empty' });
    updates.title = t.slice(0, 200);
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  try {
    // Ensure ownership before mutating.
    const owned = await getOwnedSession(req.params.id, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Session not found' });

    const { data, error } = await supabase
      .from('chat_sessions')
      .update(updates)
      .eq('id', req.params.id)
      .select(SESSION_COLUMNS)
      .single();

    if (error) {
      console.error('[chat-sessions PATCH] error:', error);
      return res.status(500).json({ error: 'Failed to update session' });
    }
    res.json({ session: data });
  } catch (err) {
    console.error('[chat-sessions PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/chat-sessions/:id — single delete. */
router.delete('/:id', async (req, res) => {
  try {
    const owned = await getOwnedSession(req.params.id, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Session not found' });

    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) {
      console.error('[chat-sessions DELETE] error:', error);
      return res.status(500).json({ error: 'Failed to delete session' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat-sessions DELETE] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/chat-sessions — bulk delete by ids. */
router.delete('/', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .delete()
      .in('id', ids)
      .eq('user_id', req.user.id)
      .select('id');

    if (error) {
      console.error('[chat-sessions DELETE bulk] error:', error);
      return res.status(500).json({ error: 'Failed to delete sessions' });
    }
    res.json({ ok: true, deleted: data?.length ?? 0 });
  } catch (err) {
    console.error('[chat-sessions DELETE bulk] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Messages ───────────────────────────────────────────────────────────────

/** GET /api/chat-sessions/:id/messages — load messages for a session. */
router.get('/:id/messages', async (req, res) => {
  try {
    const owned = await getOwnedSession(req.params.id, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Session not found' });

    const { data, error } = await supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('session_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[messages GET] error:', error);
      return res.status(500).json({ error: 'Failed to load messages' });
    }
    res.json({ messages: data ?? [] });
  } catch (err) {
    console.error('[messages GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/chat-sessions/:id/messages — append a message.
 * Touches session.updated_at as a side effect.
 */
router.post('/:id/messages', async (req, res) => {
  const { role, content, sources, confidence } = req.body || {};
  if (role !== 'user' && role !== 'assistant') {
    return res.status(400).json({ error: 'role must be user or assistant' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  try {
    const owned = await getOwnedSession(req.params.id, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Session not found' });

    const insertRow = {
      session_id: req.params.id,
      role,
      content,
    };
    if (sources != null) insertRow.sources = sources;
    if (typeof confidence === 'number') insertRow.confidence = confidence;

    const { data, error } = await supabase
      .from('messages')
      .insert(insertRow)
      .select(MESSAGE_COLUMNS)
      .single();

    if (error) {
      console.error('[messages POST] error:', error);
      return res.status(500).json({ error: 'Failed to insert message' });
    }

    // Touch the session so the history list re-orders correctly.
    await supabase
      .from('chat_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ message: data });
  } catch (err) {
    console.error('[messages POST] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/chat-sessions/messages/:messageId/feedback — set thumbs.
 * Verifies the message belongs to a session owned by the caller.
 */
router.patch('/messages/:messageId/feedback', async (req, res) => {
  const { feedback } = req.body || {};
  if (feedback !== 'helpful' && feedback !== 'not_helpful' && feedback !== null) {
    return res.status(400).json({ error: 'feedback must be helpful, not_helpful, or null' });
  }

  try {
    // Look up the message + its session's user_id to enforce ownership.
    const { data: msg, error: lookupError } = await supabase
      .from('messages')
      .select('id, session_id, chat_sessions!inner(user_id)')
      .eq('id', req.params.messageId)
      .maybeSingle();

    if (lookupError) {
      console.error('[messages feedback lookup] error:', lookupError);
      return res.status(500).json({ error: 'Failed to load message' });
    }
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.chat_sessions?.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Cannot update another user\'s message' });
    }

    const { error } = await supabase
      .from('messages')
      .update({
        user_feedback: feedback,
        feedback_timestamp: feedback ? new Date().toISOString() : null,
      })
      .eq('id', req.params.messageId);

    if (error) {
      console.error('[messages feedback] error:', error);
      return res.status(500).json({ error: 'Failed to save feedback' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[messages feedback] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
