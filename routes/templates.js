import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';
import requireAccountAdmin from '../middleware/requireAccountAdmin.js';

const router = express.Router();

router.use(requireAccountAccess);

const TEMPLATE_COLUMNS = '*';
const GENERATED_DOCUMENT_COLUMNS = '*';

// Whitelist of fields the client may set when creating/updating a template.
// account_id is set server-side from the JWT — clients can't choose.
const TEMPLATE_FIELDS = [
  'name',
  'description',
  'category',
  'template_markdown',
  'ai_instructions',
  'trigger_keywords',
  'example_output',
  'is_active',
  'custom_styles',
];

function pickTemplateFields(body) {
  const out = {};
  for (const f of TEMPLATE_FIELDS) {
    if (f in body) out[f] = body[f];
  }
  return out;
}

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * GET /api/templates?activeOnly=true|false
 *
 *   activeOnly=true (default for non-admins): any member can list active
 *     templates in their account — used by the chat trigger detection.
 *   activeOnly=false: includes inactive templates — admin only, used by
 *     the template management UI.
 */
router.get('/', async (req, res) => {
  const activeOnly = req.query.activeOnly !== 'false';

  if (!activeOnly && !['super_admin', 'account_admin', 'admin'].includes(req.role)) {
    return res.status(403).json({ error: 'Account admin required to list inactive templates' });
  }

  try {
    let query = supabase
      .from('document_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('account_id', req.account.id);

    if (activeOnly) {
      query = query.eq('is_active', true).order('name');
    } else {
      query = query.order('category', { ascending: true }).order('name', { ascending: true });
    }

    const { data, error } = await query;
    if (error) {
      console.error('[templates GET] error:', error);
      return res.status(500).json({ error: 'Failed to load templates' });
    }
    res.json({ templates: data ?? [] });
  } catch (err) {
    console.error('[templates GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/templates/:id — fetch a single template by ID. */
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('document_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('id', req.params.id)
      .eq('account_id', req.account.id)
      .maybeSingle();

    if (error) {
      console.error('[templates GET :id] error:', error);
      return res.status(500).json({ error: 'Failed to load template' });
    }
    if (!data) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: data });
  } catch (err) {
    console.error('[templates GET :id] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/templates — create. Admin only. */
router.post('/', requireAccountAdmin, async (req, res) => {
  const fields = pickTemplateFields(req.body || {});
  if (!fields.name || typeof fields.name !== 'string' || !fields.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (typeof fields.template_markdown !== 'string' || !fields.template_markdown.trim()) {
    return res.status(400).json({ error: 'template_markdown is required' });
  }

  try {
    const { data, error } = await supabase
      .from('document_templates')
      .insert({ ...fields, account_id: req.account.id })
      .select(TEMPLATE_COLUMNS)
      .single();

    if (error) {
      console.error('[templates POST] error:', error);
      return res.status(500).json({ error: 'Failed to create template' });
    }
    res.json({ template: data });
  } catch (err) {
    console.error('[templates POST] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/templates/:id — update. Admin only. */
router.patch('/:id', requireAccountAdmin, async (req, res) => {
  const fields = pickTemplateFields(req.body || {});
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  try {
    const { data, error } = await supabase
      .from('document_templates')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('account_id', req.account.id)
      .select(TEMPLATE_COLUMNS);

    if (error) {
      console.error('[templates PATCH] error:', error);
      return res.status(500).json({ error: 'Failed to update template' });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json({ template: data[0] });
  } catch (err) {
    console.error('[templates PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/templates/:id — delete. Admin only. */
router.delete('/:id', requireAccountAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('document_templates')
      .delete()
      .eq('id', req.params.id)
      .eq('account_id', req.account.id)
      .select('id');

    if (error) {
      console.error('[templates DELETE] error:', error);
      return res.status(500).json({ error: 'Failed to delete template' });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[templates DELETE] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Generated documents (audit trail of filled templates) ──────────────────

/**
 * POST /api/templates/generated
 * Body: { templateId, sessionId, filledContent, metadata? }
 * Server sets user_id + account_id from JWT.
 */
router.post('/generated', async (req, res) => {
  const { templateId, sessionId, filledContent, metadata } = req.body || {};
  if (typeof filledContent !== 'string' || !filledContent.trim()) {
    return res.status(400).json({ error: 'filledContent is required' });
  }

  try {
    const { data, error } = await supabase
      .from('generated_documents')
      .insert({
        template_id: typeof templateId === 'string' ? templateId : null,
        session_id: typeof sessionId === 'string' ? sessionId : null,
        user_id: req.user.id,
        account_id: req.account.id,
        filled_content: filledContent,
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
      })
      .select(GENERATED_DOCUMENT_COLUMNS)
      .single();

    if (error) {
      console.error('[generated-documents POST] error:', error);
      return res.status(500).json({ error: 'Failed to save generated document' });
    }
    res.json({ document: data });
  } catch (err) {
    console.error('[generated-documents POST] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/templates/generated?limit=N — list caller's generated documents.
 */
router.get('/generated', async (req, res) => {
  const limitParam = parseInt(String(req.query.limit ?? ''), 10);
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

  try {
    const { data, error } = await supabase
      .from('generated_documents')
      .select(GENERATED_DOCUMENT_COLUMNS)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[generated-documents GET] error:', error);
      return res.status(500).json({ error: 'Failed to load generated documents' });
    }
    res.json({ documents: data ?? [] });
  } catch (err) {
    console.error('[generated-documents GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
