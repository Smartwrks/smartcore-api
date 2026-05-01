import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';
import requireAccountAdmin from '../middleware/requireAccountAdmin.js';

const router = express.Router();

router.use(requireAccountAccess);
router.use(requireAccountAdmin);

/**
 * POST /api/admin/analysis/delete-qa
 * Body: { assistantMessageId } | { assistantMessageIds: string[] }
 *
 * Deletes the assistant message(s) AND the preceding user question in
 * the same session, so the Q&A pair disappears from the analysis view.
 * Each pair is account-scoped: the session it belongs to must be in
 * the caller's account.
 */
router.post('/delete-qa', async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.assistantMessageIds)
    ? body.assistantMessageIds
    : body.assistantMessageId
      ? [body.assistantMessageId]
      : [];

  if (ids.length === 0) {
    return res.status(400).json({ error: 'assistantMessageId or assistantMessageIds is required' });
  }

  try {
    // Fetch all the assistant messages in one round-trip; verify account scoping.
    const { data: assistants, error: assistantsError } = await supabase
      .from('messages')
      .select('id, session_id, role, created_at')
      .in('id', ids);

    if (assistantsError) {
      console.error('[admin/analysis delete-qa] lookup error:', assistantsError);
      return res.status(500).json({ error: 'Failed to load messages' });
    }

    const found = assistants ?? [];
    if (found.length === 0) {
      return res.status(404).json({ error: 'No matching messages found' });
    }

    // Verify each session belongs to caller's account.
    const sessionIds = [...new Set(found.map((m) => m.session_id))];
    const { data: sessions, error: sessionsError } = await supabase
      .from('chat_sessions')
      .select('id, account_id')
      .in('id', sessionIds);
    if (sessionsError) {
      console.error('[admin/analysis delete-qa] session lookup error:', sessionsError);
      return res.status(500).json({ error: 'Failed to verify ownership' });
    }
    const ownedSessionIds = new Set(
      (sessions ?? [])
        .filter((s) => s.account_id === req.account.id)
        .map((s) => s.id),
    );
    const allowedAssistants = found.filter(
      (m) => m.role === 'assistant' && ownedSessionIds.has(m.session_id),
    );
    if (allowedAssistants.length === 0) {
      return res.status(403).json({ error: 'No deletable messages in your account' });
    }

    // For each owned assistant message, find the immediately preceding user message
    // in the same session.
    const idsToDelete = new Set(allowedAssistants.map((m) => m.id));
    await Promise.all(
      allowedAssistants.map(async (a) => {
        const { data: prevUser } = await supabase
          .from('messages')
          .select('id')
          .eq('session_id', a.session_id)
          .eq('role', 'user')
          .lt('created_at', a.created_at)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (prevUser?.id) idsToDelete.add(prevUser.id);
      }),
    );

    const { data: deleted, error: deleteError } = await supabase
      .from('messages')
      .delete()
      .in('id', Array.from(idsToDelete))
      .select('id');

    if (deleteError) {
      console.error('[admin/analysis delete-qa] delete error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete messages' });
    }

    res.json({
      ok: true,
      deletedCount: deleted?.length ?? 0,
      pairsDeleted: allowedAssistants.length,
    });
  } catch (err) {
    console.error('[admin/analysis delete-qa] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
