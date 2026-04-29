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

export default router;
