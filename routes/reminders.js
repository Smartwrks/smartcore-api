import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

const REMINDER_COLUMNS =
  'id, user_id, account_id, session_id, message_id, content, due_date, completed, completed_at, reminded_at, created_at, updated_at';

/**
 * POST /api/reminders
 * Body: { reminders: [{content, dueDate?}], sessionId?, messageId? }
 * Server sets user_id from JWT and account_id from req.account.id.
 */
router.post('/', async (req, res) => {
  const { reminders, sessionId, messageId } = req.body || {};
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return res.status(400).json({ error: 'reminders array is required' });
  }

  // Validate each reminder shape; reject the whole batch on bad input.
  for (const r of reminders) {
    if (!r || typeof r.content !== 'string' || !r.content.trim()) {
      return res.status(400).json({ error: 'each reminder requires non-empty content' });
    }
  }

  const rows = reminders.map((r) => ({
    user_id: req.user.id,
    account_id: req.account.id,
    session_id: typeof sessionId === 'string' ? sessionId : null,
    message_id: typeof messageId === 'string' ? messageId : null,
    content: r.content,
    due_date: typeof r.dueDate === 'string' ? r.dueDate : null,
  }));

  try {
    const { data, error } = await supabase
      .from('reminders')
      .insert(rows)
      .select(REMINDER_COLUMNS);

    if (error) {
      console.error('[reminders POST] error:', error);
      return res.status(500).json({ error: 'Failed to save reminders' });
    }

    res.json({ reminders: data ?? [] });
  } catch (err) {
    console.error('[reminders POST] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reminders — list active (not completed) reminders for caller.
 * Sorted by due_date ascending (nulls last), then created_at descending.
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reminders')
      .select(REMINDER_COLUMNS)
      .eq('user_id', req.user.id)
      .eq('completed', false)
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[reminders GET] error:', error);
      return res.status(500).json({ error: 'Failed to load reminders' });
    }

    res.json({ reminders: data ?? [] });
  } catch (err) {
    console.error('[reminders GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/reminders/:id/complete — mark as completed.
 * Ownership-checked via user_id filter.
 */
router.patch('/:id/complete', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reminders')
      .update({
        completed: true,
        completed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id');

    if (error) {
      console.error('[reminders complete] error:', error);
      return res.status(500).json({ error: 'Failed to complete reminder' });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[reminders complete] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/reminders/:id — delete the reminder if it belongs to caller.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reminders')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id');

    if (error) {
      console.error('[reminders DELETE] error:', error);
      return res.status(500).json({ error: 'Failed to delete reminder' });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[reminders DELETE] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
