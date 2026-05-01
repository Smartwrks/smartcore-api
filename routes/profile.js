import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

const PROFILE_COLUMNS =
  'id, account_id, display_name, role, ai_instructions, avatar_url, created_at, updated_at';

// Fields a user may update on their own profile. account_id, id, role, and
// timestamps are never client-editable here.
const EDITABLE_FIELDS = ['display_name', 'ai_instructions', 'avatar_url'];

/** GET /api/profile — fetch the caller's profile. */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) {
      console.error('[profile GET] error:', error);
      return res.status(500).json({ error: 'Failed to load profile' });
    }
    if (!data) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile: data });
  } catch (err) {
    console.error('[profile GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/profile — update editable fields on the caller's profile. */
router.patch('/', async (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const f of EDITABLE_FIELDS) {
    if (f in body) {
      const v = body[f];
      // Allow null or string. Reject other types (defense in depth).
      if (v !== null && typeof v !== 'string') {
        return res.status(400).json({ error: `${f} must be a string or null` });
      }
      updates[f] = v;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select(PROFILE_COLUMNS)
      .single();

    if (error) {
      console.error('[profile PATCH] error:', error);
      return res.status(500).json({ error: 'Failed to update profile' });
    }
    res.json({ profile: data });
  } catch (err) {
    console.error('[profile PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
