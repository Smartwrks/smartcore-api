import express from 'express';
import { supabase } from '../server.js';
import requireAccountAccess from '../middleware/requireAccountAccess.js';

const router = express.Router();

router.use(requireAccountAccess);

const DOC_COLUMNS =
  'id, account_id, filename, original_name, file_type, file_size, storage_path, purpose, description, status, extracted_text, processing_error, uploaded_by, created_at, processed_at';

const STORAGE_BUCKET = 'template-examples';

const VALID_STATUSES = new Set(['uploaded', 'processing', 'processed', 'error']);

// Whitelist of fields the client may set when creating an uploaded_documents row.
// account_id + uploaded_by come from the JWT.
const CREATE_FIELDS = [
  'filename',
  'original_name',
  'file_type',
  'file_size',
  'storage_path',
  'purpose',
  'description',
];

/**
 * POST /api/uploaded-documents — create a metadata row.
 *
 * The browser uploads the file directly to Supabase Storage (using the
 * publishable key + RLS). It then calls this endpoint to register the
 * metadata. account_id and uploaded_by are taken from the JWT.
 */
router.post('/', async (req, res) => {
  const body = req.body || {};
  const insertRow = { account_id: req.account.id, uploaded_by: req.user.id, status: 'uploaded' };
  for (const field of CREATE_FIELDS) {
    if (field in body) insertRow[field] = body[field];
  }

  if (!insertRow.filename || !insertRow.storage_path) {
    return res.status(400).json({ error: 'filename and storage_path are required' });
  }

  try {
    const { data, error } = await supabase
      .from('uploaded_documents')
      .insert(insertRow)
      .select(DOC_COLUMNS)
      .single();

    if (error) {
      console.error('[uploaded-docs POST] error:', error);
      return res.status(500).json({ error: 'Failed to create document record' });
    }
    res.json({ document: data });
  } catch (err) {
    console.error('[uploaded-docs POST] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/uploaded-documents?purpose=...&limit=N */
router.get('/', async (req, res) => {
  const limitParam = parseInt(String(req.query.limit ?? ''), 10);
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;
  const purpose = typeof req.query.purpose === 'string' ? req.query.purpose : null;

  try {
    let query = supabase
      .from('uploaded_documents')
      .select(DOC_COLUMNS)
      .eq('account_id', req.account.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (purpose) query = query.eq('purpose', purpose);

    const { data, error } = await query;
    if (error) {
      console.error('[uploaded-docs GET] error:', error);
      return res.status(500).json({ error: 'Failed to load documents' });
    }
    res.json({ documents: data ?? [] });
  } catch (err) {
    console.error('[uploaded-docs GET] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/uploaded-documents/:id */
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('uploaded_documents')
      .select(DOC_COLUMNS)
      .eq('id', req.params.id)
      .eq('account_id', req.account.id)
      .maybeSingle();

    if (error) {
      console.error('[uploaded-docs GET :id] error:', error);
      return res.status(500).json({ error: 'Failed to load document' });
    }
    if (!data) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: data });
  } catch (err) {
    console.error('[uploaded-docs GET :id] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/uploaded-documents/:id — update status / extracted_text / error. */
router.patch('/:id', async (req, res) => {
  const { status, extractedText, processingError } = req.body || {};
  const updates = { processed_at: new Date().toISOString() };

  if (status !== undefined) {
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      return res.status(400).json({
        error: `status must be one of: ${Array.from(VALID_STATUSES).join(', ')}`,
      });
    }
    updates.status = status;
  }
  if (extractedText !== undefined) {
    updates.extracted_text = typeof extractedText === 'string' ? extractedText : null;
  }
  if (processingError !== undefined) {
    updates.processing_error = typeof processingError === 'string' ? processingError : null;
  }

  if (Object.keys(updates).length === 1) {
    // Only processed_at is set — caller didn't actually pass anything to update.
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  try {
    const { data, error } = await supabase
      .from('uploaded_documents')
      .update(updates)
      .eq('id', req.params.id)
      .eq('account_id', req.account.id)
      .select(DOC_COLUMNS);

    if (error) {
      console.error('[uploaded-docs PATCH] error:', error);
      return res.status(500).json({ error: 'Failed to update document' });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({ document: data[0] });
  } catch (err) {
    console.error('[uploaded-docs PATCH] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/uploaded-documents/:id
 *
 * Cascading cleanup: removes the Storage object first (best-effort), then
 * deletes the metadata row. Server uses the service-role key for Storage
 * delete so the client doesn't need to know storage paths.
 */
router.delete('/:id', async (req, res) => {
  try {
    // Look up the row first so we have the storage_path.
    const { data: doc, error: lookupError } = await supabase
      .from('uploaded_documents')
      .select('id, storage_path')
      .eq('id', req.params.id)
      .eq('account_id', req.account.id)
      .maybeSingle();

    if (lookupError) {
      console.error('[uploaded-docs DELETE lookup] error:', lookupError);
      return res.status(500).json({ error: 'Failed to load document' });
    }
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Best-effort Storage cleanup (don't fail the whole delete if Storage errors).
    if (doc.storage_path) {
      const { error: storageError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove([doc.storage_path]);
      if (storageError) {
        console.warn('[uploaded-docs DELETE] Storage remove warning:', storageError);
      }
    }

    const { error: deleteError } = await supabase
      .from('uploaded_documents')
      .delete()
      .eq('id', req.params.id)
      .eq('account_id', req.account.id);

    if (deleteError) {
      console.error('[uploaded-docs DELETE] error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete document' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[uploaded-docs DELETE] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
