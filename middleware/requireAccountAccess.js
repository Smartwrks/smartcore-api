import { supabase, authClient } from '../server.js';

/**
 * Middleware: verify the caller's JWT and attach their account context.
 *
 * Flow:
 *   1. Read Bearer token from Authorization header.
 *   2. Verify with Supabase auth → get user.
 *   3. Look up profiles row to get account_id and role.
 *   4. Look up the account row.
 *
 * On success, attaches:
 *   req.user    — verified Supabase auth user
 *   req.profile — { id, account_id, role, display_name }
 *   req.account — { id, name, slug, status }
 *   req.role    — convenience copy of req.profile.role
 *
 * Returns:
 *   401 — token missing or invalid
 *   403 — profile or account missing, or account suspended
 *   500 — unexpected DB error
 *
 * Modeled on smartvue-api's requireProjectAccess.js. The key difference
 * is that SmartCore scopes by account_id (one-per-customer) rather than
 * project_id (many-per-customer-per-account).
 */
export default async function requireAccountAccess(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const user = userData.user;

    // Look up profile (service-role, bypasses RLS).
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, account_id, role, display_name')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Profile not found' });
    }
    if (!profile.account_id) {
      return res.status(403).json({ error: 'User has no associated account' });
    }

    // Look up account.
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, slug, status')
      .eq('id', profile.account_id)
      .single();

    if (accountError || !account) {
      return res.status(403).json({ error: 'Account not found' });
    }
    if (account.status === 'suspended' || account.status === 'cancelled') {
      return res.status(403).json({ error: `Account ${account.status}` });
    }

    req.user = user;
    req.profile = profile;
    req.account = account;
    req.role = profile.role;
    next();
  } catch (error) {
    console.error('[requireAccountAccess] error:', error);
    res.status(500).json({ error: 'Authorization check failed' });
  }
}
