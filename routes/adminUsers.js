import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';
import requireAccountAdmin from '../middleware/requireAccountAdmin.js';

const router = express.Router();

router.use(requireAccountAccess);
router.use(requireAccountAdmin);

const PROFILE_COLUMNS =
  'id, account_id, display_name, role, ai_instructions, avatar_url, created_at, updated_at';

const ALLOWED_ROLES = new Set(['super_admin', 'account_admin', 'admin', 'user', 'viewer']);

/**
 * GET /api/admin/users
 *
 * List users in the caller's account, joined with auth.users for email
 * + last_sign_in_at. Includes lightweight per-user activity stats
 * (session + message counts; recent activity).
 *
 * Account scoping: profiles are filtered by req.account.id. super_admin
 * sees their own account too — for cross-account browsing we'll need a
 * separate platform endpoint later.
 */
router.get('/', async (req, res) => {
  try {
    // 1. Profiles in caller's account.
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('account_id', req.account.id)
      .order('created_at', { ascending: false });

    if (profilesError) {
      console.error('[admin/users] profiles error:', profilesError);
      return res.status(500).json({ error: 'Failed to load profiles' });
    }

    if (!profiles || profiles.length === 0) {
      return res.json({ users: [] });
    }

    // 2. Auth users — supabase.auth.admin.listUsers paginates; fetch up to 1000.
    //    For a multi-thousand-user account, we'd loop pages here.
    let authUsers = [];
    try {
      const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) {
        console.error('[admin/users] auth.admin.listUsers error:', error);
      } else {
        authUsers = data?.users ?? [];
      }
    } catch (err) {
      console.error('[admin/users] auth.admin.listUsers threw:', err);
    }
    const authById = new Map(authUsers.map((u) => [u.id, u]));

    // 3. Per-user stats. Best-effort; failures fall back to zeros.
    const enriched = await Promise.all(
      profiles.map(async (p) => {
        const auth = authById.get(p.id);

        const [sessionsRes, sessionCountRes] = await Promise.all([
          supabase.from('chat_sessions').select('id, updated_at').eq('user_id', p.id),
          supabase
            .from('chat_sessions')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', p.id),
        ]);

        const sessions = sessionsRes.data ?? [];
        const sessionIds = sessions.map((s) => s.id);

        let queriesCount = 0;
        if (sessionIds.length > 0) {
          const { count } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('role', 'user')
            .in('session_id', sessionIds);
          queriesCount = count ?? 0;
        }

        const lastSessionAt = sessions
          .map((s) => s.updated_at)
          .filter(Boolean)
          .sort()
          .reverse()[0];

        return {
          ...p,
          email: auth?.email ?? '',
          last_sign_in_at: auth?.last_sign_in_at ?? null,
          queries_count: queriesCount,
          session_count: sessionCountRes.count ?? 0,
          last_active_at: lastSessionAt ?? auth?.last_sign_in_at ?? p.created_at,
        };
      }),
    );

    res.json({ users: enriched });
  } catch (err) {
    console.error('[admin/users] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/users/:id
 *
 * Update another user's profile fields (display_name, role, ai_instructions).
 * Server enforces:
 *   - target user must be in caller's account
 *   - account_admin cannot promote anyone to super_admin (only super_admin can)
 *   - account_admin cannot demote a super_admin
 */
router.patch('/:id', async (req, res) => {
  const targetId = req.params.id;
  const body = req.body || {};

  // Load target profile to check it's in this account + current role.
  const { data: target, error: targetError } = await supabase
    .from('profiles')
    .select('id, account_id, role')
    .eq('id', targetId)
    .maybeSingle();

  if (targetError) {
    console.error('[admin/users PATCH] target lookup error:', targetError);
    return res.status(500).json({ error: 'Failed to load target user' });
  }
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.account_id !== req.account.id) {
    return res.status(403).json({ error: 'User is in a different account' });
  }

  const updates = {};
  if (typeof body.display_name === 'string') updates.display_name = body.display_name;
  if (typeof body.ai_instructions === 'string') updates.ai_instructions = body.ai_instructions;

  if ('role' in body) {
    const newRole = body.role;
    if (typeof newRole !== 'string' || !ALLOWED_ROLES.has(newRole)) {
      return res.status(400).json({
        error: `role must be one of: ${Array.from(ALLOWED_ROLES).join(', ')}`,
      });
    }
    if (newRole === 'super_admin' && req.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can promote to super_admin' });
    }
    if (target.role === 'super_admin' && req.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can change a super_admin\'s role' });
    }
    updates.role = newRole;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', targetId)
      .select(PROFILE_COLUMNS)
      .single();

    if (error) {
      console.error('[admin/users PATCH] update error:', error);
      return res.status(500).json({ error: 'Failed to update user' });
    }
    res.json({ user: data });
  } catch (err) {
    console.error('[admin/users PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/admin/users/:id — remove the profile (auth user untouched). */
router.delete('/:id', async (req, res) => {
  const targetId = req.params.id;

  // Self-delete protection.
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account here' });
  }

  // Account scoping check.
  const { data: target, error: targetError } = await supabase
    .from('profiles')
    .select('id, account_id, role')
    .eq('id', targetId)
    .maybeSingle();
  if (targetError) {
    return res.status(500).json({ error: 'Failed to load target user' });
  }
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.account_id !== req.account.id) {
    return res.status(403).json({ error: 'User is in a different account' });
  }
  if (target.role === 'super_admin' && req.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only super_admin can delete a super_admin' });
  }

  try {
    const { error } = await supabase.from('profiles').delete().eq('id', targetId);
    if (error) {
      console.error('[admin/users DELETE] error:', error);
      return res.status(500).json({ error: 'Failed to delete user' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/users DELETE] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
