import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

// All routes here require an authenticated user with an account.
router.use(requireAccountAccess);

/**
 * GET /api/account/me
 *
 * Returns the caller's account context — used by the frontend on app
 * boot to populate AccountContext (account, role, settings).
 *
 * Deliberately does NOT include account_provisioning fields (vector
 * index host, allowed model list, plan tier) — those are super_admin
 * only and exposed via /api/platform/* endpoints.
 */
router.get('/me', async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('account_settings')
      .select('global_ai_prompt, system_ai_prompt, ai_model, ai_temperature, ai_max_tokens, integrations')
      .eq('account_id', req.account.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[account/me] settings load error:', error);
      return res.status(500).json({ error: 'Failed to load account settings' });
    }

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        display_name: req.profile.display_name,
        role: req.role,
      },
      account: req.account,
      settings: settings || null,
    });
  } catch (err) {
    console.error('[account/me] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/account/settings
 *
 * Update the caller's account_settings row. Only super_admin /
 * account_admin / legacy admin may call this. Fields not in the
 * whitelist are silently dropped — the request body cannot grant
 * itself fields it shouldn't have.
 */
const SETTINGS_FIELDS = [
  'global_ai_prompt',
  'system_ai_prompt',
  'ai_model',
  'ai_temperature',
  'ai_max_tokens',
  'integrations',
];

router.patch('/settings', async (req, res) => {
  if (!['super_admin', 'account_admin', 'admin'].includes(req.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to update settings' });
  }

  const updates = {};
  for (const field of SETTINGS_FIELDS) {
    if (field in req.body) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  try {
    const { data, error } = await supabase
      .from('account_settings')
      .update(updates)
      .eq('account_id', req.account.id)
      .select('global_ai_prompt, system_ai_prompt, ai_model, ai_temperature, ai_max_tokens, integrations')
      .single();

    if (error) {
      console.error('[account/settings PATCH] error:', error);
      return res.status(500).json({ error: 'Failed to update settings' });
    }

    res.json({ settings: data });
  } catch (err) {
    console.error('[account/settings PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/account
 *
 * Update the caller's accounts row.
 *   - account_admin (or legacy admin) can edit `name`
 *   - super_admin can additionally edit `status`
 *   - `slug` is intentionally NOT editable here (URLs / external
 *     references depend on it; if needed later, treat as a separate
 *     super-admin operation with redirect handling)
 */
const VALID_STATUSES = new Set(['active', 'trial', 'suspended', 'cancelled']);

router.patch('/', async (req, res) => {
  if (!['super_admin', 'account_admin', 'admin'].includes(req.role)) {
    return res.status(403).json({ error: 'Insufficient permissions to update account' });
  }

  const updates = {};

  if ('name' in req.body) {
    const name = req.body.name;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    updates.name = name.trim();
  }

  if ('status' in req.body) {
    if (req.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can change account status' });
    }
    const status = req.body.status;
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      return res.status(400).json({
        error: `status must be one of: ${Array.from(VALID_STATUSES).join(', ')}`,
      });
    }
    updates.status = status;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  try {
    const { data, error } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', req.account.id)
      .select('id, name, slug, status')
      .single();

    if (error) {
      console.error('[account PATCH] error:', error);
      return res.status(500).json({ error: 'Failed to update account' });
    }

    res.json({ account: data });
  } catch (err) {
    console.error('[account PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
