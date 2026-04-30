/**
 * Middleware: require account-level admin (or super_admin).
 *
 * Must be mounted AFTER requireAccountAccess so req.role is set.
 * Treats legacy 'admin' as 'account_admin' during the role-tier
 * transition.
 */
const ADMIN_ROLES = new Set(['super_admin', 'account_admin', 'admin']);

export default function requireAccountAdmin(req, res, next) {
  if (!ADMIN_ROLES.has(req.role)) {
    return res.status(403).json({ error: 'Account admin permissions required' });
  }
  next();
}
